'use strict';

// ═══════════════════════════════════════════════════════════════
// NUTRITION AGENT — Pulse Backend
// All routes, AI food recognition, chat, proactive cron.
// Mounted at /api/nutrition in server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router  = express.Router();
const admin   = require('firebase-admin');
const { OpenAI } = require('openai');
const cron    = require('node-cron');

const { MODELS, OPENAI_TIMEOUT_MS, safeJSON, assertImageSize } = require('./lib/model-router');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: OPENAI_TIMEOUT_MS });
const db = () => admin.firestore();

// ─── Firestore path helpers ───────────────────────────────────
const userDoc  = (id) => db().collection('wellness_users').doc(id);
const nutDoc   = (id) => userDoc(id).collection('agents').doc('nutrition');
const logsCol  = (id) => nutDoc(id).collection('food_logs');
const chatsCol = (id) => nutDoc(id).collection('nutrition_chats');
const actionsCol = (id) => nutDoc(id).collection('nutrition_actions');

// ════════════════════════════════════════════════════════════════
// ACTIONS v2 — shared engine
// ════════════════════════════════════════════════════════════════
const { mountActionRoutes, gradeActions: _gradeActionsShared } = require('./lib/actions-engine');
const { computeNutritionCandidates, nutritionGraders } = require('./lib/candidates/nutrition');
const { assertNoCrossAgent } = require('./lib/sandbox');
const { computeNutritionScore: _computeNutritionScore } = require('./lib/agent-scores');
const { fetchAgentSnapshot } = require('./lib/cross-agent-context');
assertNoCrossAgent('nutrition', computeNutritionCandidates);
const _v2Hooks = mountActionRoutes(router, {
  agentName: 'nutrition',
  agentDocRef: nutDoc,
  actionsCol, logsCol,
  computeCandidates: computeNutritionCandidates,
  graders: nutritionGraders,
  openai, admin, db,
  crossAgentEnricher: async (deviceId) => {
    const [fitnessSnap, sleepSnap] = await Promise.all([
      fetchAgentSnapshot(deviceId, 'fitness', 1).catch(() => null),
      fetchAgentSnapshot(deviceId, 'sleep', 1).catch(() => null),
    ]);
    const parts = [];
    if (fitnessSnap?.logs?.length) {
      const w = fitnessSnap.logs[0];
      const muscles = Array.isArray(w.muscle_groups) ? w.muscle_groups.join(', ') : (w.muscle_groups || 'full body');
      parts.push(`Trained yesterday: ${muscles}. Increase protein today for recovery.`);
    }
    if (sleepSnap?.logs?.length) {
      const q = sleepSnap.logs[0].quality || 3;
      if (q <= 2) parts.push(`Poor sleep last night (quality ${q}/5) → focus on energy-stabilising foods, avoid sugar spikes.`);
    }
    return parts.join(' ');
  },
});
function _onNutritionLog(deviceId) {
  nutDoc(deviceId).update({
    log_count_since_last_batch: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});
  _v2Hooks.queueGeneration(deviceId);
  _gradeActionsShared({
    agentName: 'nutrition', deviceId, actionsCol, logsCol,
    graders: nutritionGraders, admin, db,
  }).catch(() => {});
  try { require('./wellness.cross').invalidateWellnessCache?.(deviceId); } catch {}
}
// ════════════════════════════════════════════════════════════════

// ─── Helpers ──────────────────────────────────────────────────
const dateStr = (d = new Date()) => {
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
};

const getWeekKey = (d = new Date()) => {
  const diff = (d.getDay() + 6) % 7;
  const mon  = new Date(d);
  mon.setDate(d.getDate() - diff);
  return dateStr(mon);
};

const mapSnapDoc = (doc) => ({ id: doc.id, ...doc.data() });

const toIsoString = (value) => {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

// ─── Macro target calculator (Mifflin-St Jeor, graceful fallback) ───────────
function calcTargets(setup) {
  const {
    goal = 'maintain', activity_level = 'moderate',
    weight_kg, height_cm, age_years, gender = 'other',
  } = setup;

  const w = parseFloat(weight_kg)  || null;
  const h = parseFloat(height_cm)  || null;
  const a = parseFloat(age_years)  || null;
  const g = gender || 'other';

  // Gender-based average heights used when height not entered
  const avgH = g === 'female' ? 163 : 175;
  // Gender-based fallback body weights for protein calc
  const fallbackW = g === 'female' ? 62 : 78;

  let bmr;
  if (w && h && a) {
    // Full Mifflin-St Jeor
    if (g === 'male')        bmr = 10*w + 6.25*h - 5*a + 5;
    else if (g === 'female') bmr = 10*w + 6.25*h - 5*a - 161;
    else                     bmr = 10*w + 6.25*h - 5*a - 78;
  } else if (w && a) {
    // Weight + age, assume average height
    if (g === 'male')        bmr = 10*w + 6.25*avgH - 5*a + 5;
    else if (g === 'female') bmr = 10*w + 6.25*avgH - 5*a - 161;
    else                     bmr = 10*w + 6.25*avgH - 5*a - 78;
  } else if (w) {
    // Weight only — Katch-McArdle simplified (assumes 20% body fat)
    bmr = 370 + 17.5 * w;
  } else if (a) {
    // Age + gender only — population average adjusted for age
    const base = g === 'female' ? 1480 : 1780;
    bmr = base - Math.max(0, (a - 30) * 7);
  } else {
    bmr = g === 'female' ? 1550 : 1800;
  }

  const actMult  = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };
  const tdee     = bmr * (actMult[activity_level] || 1.55);
  const goalAdj  = { lose: -500, gain: 300, maintain: 0, healthier: 0, energy: 0 };
  const calTarget = Math.round(tdee + (goalAdj[goal] || 0));

  // Evidence-based protein targets (g/kg body weight)
  // lose: 2.0 — preserves muscle in deficit (Helms et al. 2014)
  // gain: 2.2 — maximises MPS (Morton et al. 2018)
  // healthier/energy: 1.6 — ISSN position stand minimum for active adults
  // maintain: 1.5
  const protPerKg = { lose: 2.0, gain: 2.2, healthier: 1.6, energy: 1.6, maintain: 1.5 };
  const bodyW     = w || fallbackW;
  const protTarget = Math.round(bodyW * (protPerKg[goal] || 1.6));
  const fatTarget  = Math.round((calTarget * 0.28) / 9);
  const carbTarget = Math.round((calTarget - protTarget * 4 - fatTarget * 9) / 4);

  return {
    calorie_target: Math.max(calTarget, 1200),
    protein_target: protTarget,
    carb_target:    Math.max(carbTarget, 50),
    fat_target:     Math.max(fatTarget, 30),
    water_target_cups: 8,
  };
}

// ─── USDA FoodData Central search ────────────────────────────
// "Apples, fuji, with skin, raw" → { name: "Apples", preparation: "raw" }
// Extracts only the most useful single-word preparation tag
const PREP_KEYWORDS = ['raw', 'cooked', 'dried', 'dehydrated', 'frozen', 'baked',
  'boiled', 'roasted', 'grilled', 'steamed', 'fried', 'smoked', 'canned', 'fresh'];

function splitUSDADescription(description) {
  const idx = description.indexOf(',');
  if (idx === -1) return { name: description, preparation: null };

  const name    = description.slice(0, idx).trim();
  const rest    = description.slice(idx + 1).toLowerCase();

  // Find first matching keyword in the preparation text
  const prep = PREP_KEYWORDS.find(k => rest.includes(k)) || null;

  return { name, preparation: prep };
}

function parseUSDAFoods(foods, dataTypeRank) {
  return (foods || []).map(f => {
    const getNutrient = (id) => (f.foodNutrients || []).find(n => n.nutrientId === id)?.value || 0;
    const calories    = getNutrient(1008) || getNutrient(2047);
    const { name, preparation } = splitUSDADescription(f.description);
    return {
      id:           `usda_${f.fdcId}`,
      name,
      preparation,                      // e.g. "raw", "cooked", "dehydrated"
      brand:        f.brandOwner || null,
      dataTypeRank,
      serving_size: 100,
      serving_unit: 'g',
      calories:     Math.round(calories),
      protein:      Math.round(getNutrient(1003) * 10) / 10,
      carbs:        Math.round(getNutrient(1005) * 10) / 10,
      fat:          Math.round(getNutrient(1004) * 10) / 10,
      source:       'usda',
    };
  }).filter(f => f.calories > 0);
}

async function searchUSDA(query) {
  try {
    const apiKey = process.env.USDA_API_KEY || 'DEMO_KEY';
    const q      = query.trim();
    const base   = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${apiKey}`;
    const whole  = `&dataType=Foundation,SR%20Legacy`;
    const signal = AbortSignal.timeout(7000);

    // Three parallel calls:
    // 1. Exact query in Foundation/SR Legacy
    // 2. "{query}s, raw" — catches "Apples, raw" for query "apple"
    // 3. Branded/Survey for variety
    const qRaw   = `${q}s, raw`;
    const qSingle = `${q}, raw`;

    const [r1, r2, r3, r4] = await Promise.all([
      fetch(`${base}&query=${encodeURIComponent(q)}${whole}&pageSize=10`, { signal }),
      fetch(`${base}&query=${encodeURIComponent(qRaw)}${whole}&pageSize=5`, { signal }),
      fetch(`${base}&query=${encodeURIComponent(qSingle)}${whole}&pageSize=5`, { signal }),
      fetch(`${base}&query=${encodeURIComponent(q)}&dataType=Survey%20(FNDDS),Branded&pageSize=15`, { signal }),
    ]);

    const [d1, d2, d3, d4] = await Promise.all([
      r1.ok ? r1.json() : {},
      r2.ok ? r2.json() : {},
      r3.ok ? r3.json() : {},
      r4.ok ? r4.json() : {},
    ]);

    return [
      ...parseUSDAFoods(d2.foods, 0), // "{q}s, raw" results first — highest priority whole food
      ...parseUSDAFoods(d3.foods, 0), // "{q}, raw" results
      ...parseUSDAFoods(d1.foods, 0), // general Foundation/SR Legacy
      ...parseUSDAFoods(d4.foods, 2), // Branded/Survey last
    ];
  } catch { return []; }
}

// ─── FatSecret API (10/10 search — activate with API keys) ───
// Sign up free at: https://platform.fatsecret.com/api/Default.aspx?screen=r
// Add to .env: FATSECRET_CLIENT_ID=xxx  FATSECRET_CLIENT_SECRET=xxx
let _fsToken = null;
let _fsTokenExp = 0;

async function getFatSecretToken() {
  if (_fsToken && Date.now() < _fsTokenExp) return _fsToken;
  const id  = process.env.FATSECRET_CLIENT_ID;
  const sec = process.env.FATSECRET_CLIENT_SECRET;
  if (!id || !sec) return null;
  try {
    const creds = Buffer.from(`${id}:${sec}`).toString('base64');
    const res   = await fetch('https://oauth.fatsecret.com/connect/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=basic',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    _fsToken    = data.access_token;
    _fsTokenExp = Date.now() + (data.expires_in - 60) * 1000;
    return _fsToken;
  } catch { return null; }
}

async function searchFatSecret(query) {
  const token = await getFatSecretToken();
  if (!token) return [];
  try {
    const params = new URLSearchParams({
      method: 'foods.search', search_expression: query,
      format: 'json', max_results: '10', page_number: '0',
    });
    const res = await fetch(`https://platform.fatsecret.com/rest/server.api?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data  = await res.json();
    const foods = Array.isArray(data.foods?.food) ? data.foods.food : (data.foods?.food ? [data.foods.food] : []);
    return foods.map(f => {
      // Parse: "Per 1 medium (182g) - Calories: 95kcal | Fat: 0.3g | Carbs: 25.0g | Protein: 0.5g"
      const desc    = f.food_description || '';
      const serving = desc.match(/Per (.+?) - /)?.[1] || '100g';
      const cal     = parseFloat(desc.match(/Calories: ([\d.]+)kcal/)?.[1] || 0);
      const fat     = parseFloat(desc.match(/Fat: ([\d.]+)g/)?.[1]      || 0);
      const carbs   = parseFloat(desc.match(/Carbs: ([\d.]+)g/)?.[1]    || 0);
      const protein = parseFloat(desc.match(/Protein: ([\d.]+)g/)?.[1]  || 0);
      // Extract serving weight from "1 medium (182g)" → 182
      const wMatch   = serving.match(/\((\d+(?:\.\d+)?)g\)/);
      const servingG = wMatch ? parseFloat(wMatch[1]) : 100;
      return {
        id:                  `fs_${f.food_id}`,
        name:                f.food_name,
        preparation:         null,
        brand:               f.brand_name || null,
        serving_description: serving,       // "1 medium (182g)"
        serving_size:        servingG,
        serving_unit:        'g',
        calories:            cal,
        protein,
        carbs,
        fat,
        source:              'fatsecret',
        dataTypeRank:        f.food_type === 'Generic' ? 0 : 2,
      };
    }).filter(f => f.calories > 0);
  } catch { return []; }
}

// ─── Re-rank: name-match quality + whole-food preference ─────
function rankSearchResults(results, query) {
  const q     = query.toLowerCase().trim();
  const words = q.split(/\s+/).filter(w => w.length >= 3);
  const escQ  = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const scored = results.map(item => {
    const name = (item.name || '').toLowerCase();

    // Discard if query doesn't appear anywhere in the food name
    const nameContains = name.includes(q) ||
      name.includes(q + 's') ||                                              // plural
      (words.length > 1 && words.every(w => name.includes(w))) ||
      (q.length >= 5 && name.includes(q.slice(0, Math.floor(q.length * 0.75))));
    if (!nameContains) return null;

    let score = 0;

    // ── Name match quality ──
    const firstName = name.split(/[\s,]/)[0]; // e.g. "bananas" from "Bananas, raw"
    if (name === q)                                                    score += 500;
    else if (firstName === q || firstName === q + 's')                score += 450; // "Bananas" for "banana"
    else if (name.startsWith(q + ',') || name.startsWith(q + ' '))   score += 380;
    else if (name.startsWith(q))                                      score += 340;
    else if (new RegExp(`\\b${escQ}s?\\b`).test(name))               score += 220; // whole word (plural ok)
    else if (name.includes(q))                                        score += 120;
    else                                                               score += 40;

    // ── Whole food bonus (Foundation/SR Legacy) ──
    score -= (item.dataTypeRank ?? 2) * 60; // Foundation=0pts lost, Branded=120pts lost

    // ── Short clean name bonus (raw foods have short names) ──
    score -= Math.min(60, Math.floor(name.length / 5));

    // ── No brand = unprocessed whole food ──
    if (!item.brand) score += 40;

    return { item, score };
  }).filter(Boolean);

  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => {
    // eslint-disable-next-line no-unused-vars
    const { dataTypeRank, ...rest } = s.item;
    return rest;
  });
}

// ─── Open Food Facts search ───────────────────────────────────
async function searchOpenFoodFacts(query) {
  try {
    const url = `https://world.openfoodfacts.org/cgi/search.pl?action=process&json=1&search_terms=${encodeURIComponent(query)}&page_size=6&fields=product_name,brands,nutriments,serving_size,serving_quantity`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.products || [])
      .filter(p => p.product_name && p.nutriments?.['energy-kcal_100g'])
      .map(p => ({
        id:           `off_${p.code || Math.random()}`,
        name:         p.product_name,
        brand:        p.brands || null,
        serving_size: parseFloat(p.serving_quantity) || 100,
        serving_unit: 'g',
        calories:     Math.round(p.nutriments['energy-kcal_100g'] || 0),
        protein:      Math.round((p.nutriments['proteins_100g'] || 0) * 10) / 10,
        carbs:        Math.round((p.nutriments['carbohydrates_100g'] || 0) * 10) / 10,
        fat:          Math.round((p.nutriments['fat_100g'] || 0) * 10) / 10,
        source:       'openfoodfacts',
      }));
  } catch { return []; }
}

// ─── Barcode lookup (Open Food Facts) ────────────────────────
async function lookupBarcode(barcode) {
  try {
    const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    const p = data.product;
    const n = p.nutriments || {};
    return {
      id:           `off_${barcode}`,
      name:         p.product_name || p.product_name_en || 'Unknown product',
      brand:        p.brands || null,
      serving_size: parseFloat(p.serving_quantity) || 100,
      serving_unit: 'g',
      calories:     Math.round(n['energy-kcal_100g'] || n['energy-kcal'] || 0),
      protein:      Math.round((n['proteins_100g'] || 0) * 10) / 10,
      carbs:        Math.round((n['carbohydrates_100g'] || 0) * 10) / 10,
      fat:          Math.round((n['fat_100g'] || 0) * 10) / 10,
      source:       'barcode',
    };
  } catch { return null; }
}

// ─── GPT-4.1 Vision food recognition — precision prompt ───────
// userContext: { dietaryStyle, goal, cuisineHint, mealTime }
async function recognizeFood(imageBase64, userContext = {}) {
  const { dietaryStyle, goal, cuisineHint, mealTime } = userContext;

  const ctxLines = [];
  if (dietaryStyle === 'vegan')        ctxLines.push('User is VEGAN — no animal products expected.');
  if (dietaryStyle === 'vegetarian')   ctxLines.push('User is VEGETARIAN — no meat expected.');
  if (dietaryStyle === 'keto' || dietaryStyle === 'low_carb') ctxLines.push('User eats low-carb/keto — pay extra attention to carb content.');
  if (cuisineHint)  ctxLines.push(`Likely cuisine context: ${cuisineHint}.`);
  if (mealTime)     ctxLines.push(`Meal time: ${mealTime} — weight portion estimates accordingly.`);
  if (goal === 'muscle_gain') ctxLines.push('User is focused on muscle gain — be especially precise about protein sources.');
  const userCtxStr = ctxLines.length ? ctxLines.join(' ') : 'No special dietary context.';

  const prompt = `You are an expert nutritionist and food scientist analyzing a photo to track calories and macros with clinical-grade accuracy.

USER CONTEXT: ${userCtxStr}

STEP 1 — IDENTIFY: Look at every distinct food/drink item in the image. Name each one specifically.
STEP 2 — ESTIMATE PORTIONS: Use visual reference points (plate diameter ≈26cm, rice bowl ≈350ml, drinking glass ≈250ml). Account for density. If a portion looks large, it probably is.
STEP 3 — CALCULATE: Use these verified database values as anchors — interpolate for your specific quantities:

REFERENCE DATABASE (per serving as described):
- Whole wheat roti 25cm: 40g → 120kcal, 3g protein, 24g carbs, 2g fat
- Basmati rice cooked 1 cup: 180g → 240kcal, 4g protein, 53g carbs, 0.5g fat
- Dal (any lentil curry) 1 cup: 200g → 230kcal, 14g protein, 38g carbs, 4g fat
- Chicken breast cooked 100g: 165kcal, 31g protein, 0g carbs, 3.6g fat
- Chicken thigh cooked 100g: 210kcal, 26g protein, 0g carbs, 12g fat
- Salmon cooked 100g: 208kcal, 28g protein, 0g carbs, 12g fat
- Large egg whole: 50g → 70kcal, 6g protein, 0.5g carbs, 5g fat
- Whole milk 100ml: 61kcal, 3.2g protein, 4.7g carbs, 3.3g fat
- White bread slice: 28g → 79kcal, 3g protein, 15g carbs, 1g fat
- Banana medium: 120g → 107kcal, 1.3g protein, 27g carbs, 0.4g fat
- Apple medium: 182g → 95kcal, 0.5g protein, 25g carbs, 0.3g fat
- Olive oil 1 tbsp: 14g → 119kcal, 0g protein, 0g carbs, 14g fat
- Butter 1 tbsp: 14g → 102kcal, 0.1g protein, 0g carbs, 11.5g fat
- Greek yogurt 100g: 59kcal, 10g protein, 3.6g carbs, 0.4g fat
- Oats cooked 1 cup: 234g → 166kcal, 6g protein, 28g carbs, 4g fat
- Paneer 100g: 265kcal, 18g protein, 3.4g carbs, 20g fat
- Paratha medium: 55g → 180kcal, 4g protein, 26g carbs, 7g fat
- Pizza slice standard: 107g → 285kcal, 12g protein, 36g carbs, 10g fat
- Burger standard beef: 220g → 540kcal, 25g protein, 40g carbs, 29g fat

STRICT RULES:
- Separate EACH food item — never combine a plate into one entry
- Use SPECIFIC names (not "rice" → "basmati rice"; not "bread" → "whole wheat roti")
- Units: drinks/soups in ml, whole pieces as "piece", everything else in g
- Confidence: "high" = clearly visible + portion obvious | "medium" = food clear, portion estimated | "low" = partially obscured or guessing
- If this is a nutrition label/barcode (no actual food visible), return: {"items":[],"is_label":true}
- NEVER return {"items":[]} for actual food — always estimate even if unsure (use "low" confidence)

Return ONLY valid JSON, absolutely no markdown or explanation:
{"items":[{"name":"grilled chicken breast","quantity":150,"unit":"g","emoji":"🍗","confidence":"high","calories":247,"protein":46,"carbs":0,"fat":5}]}`;

  assertImageSize(imageBase64);

  const completion = await openai.chat.completions.create({
    model: MODELS.vision,
    max_tokens: 1000,
    temperature: 0.2,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const parsed = safeJSON(completion.choices[0].message.content, { items: [] });
  if (!parsed) throw new Error('Vision response was not valid JSON');
  return parsed;
}

// ─── GPT-4o Vision nutrition label scanner ────────────────────
async function scanNutritionLabel(imageBase64) {
  const prompt = `You are reading a nutrition facts label on food packaging. Extract the EXACT printed numbers — do not estimate.

Return ONLY valid JSON, no markdown:
{
  "food_name": "Product name from packaging, or 'Scanned food'",
  "serving_description": "exactly as printed e.g. '1 cup (240ml)' or '30g'",
  "serving_size_g": 240,
  "calories": 150,
  "protein": 8.0,
  "carbs": 12.0,
  "fat": 5.0,
  "confidence": "high"
}

If this is NOT a nutrition label or numbers are unreadable, return:
{"error": "No readable nutrition label found"}`;

  assertImageSize(imageBase64);

  const completion = await openai.chat.completions.create({
    model: MODELS.vision,
    max_tokens: 300,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'high' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const parsed = safeJSON(completion.choices[0].message.content, { error: 'No readable nutrition label found' });
  if (!parsed) return { error: 'No readable nutrition label found' };
  return parsed;
}

// ─── Cross-agent data reader ──────────────────────────────────
async function getCrossAgentData(deviceId) {
  const today = dateStr();

  try {
    const [sleepSnap, mindSnap, fitnessSnap] = await Promise.allSettled([
      userDoc(deviceId).collection('agents').doc('sleep')
        .collection('sleep_logs').orderBy('date_str', 'desc').limit(1).get(),
      userDoc(deviceId).collection('agents').doc('mind')
        .collection('mind_checkins').where('date_str', '==', today).get(),
      // Read fitness snapshot for protein-aware coaching
      fetchAgentSnapshot(deviceId, 'fitness', 1).catch(() => null),
    ]);

    let lastSleepHours = null;
    let lastSleepDate  = null;
    if (sleepSnap.status === 'fulfilled' && !sleepSnap.value.empty) {
      const s = sleepSnap.value.docs[0].data();
      lastSleepHours = s.total_sleep_hours || null;
      lastSleepDate  = s.date_str || null;
    }

    let todayMoodAvg    = null;
    let todayMaxAnxiety = null;
    if (mindSnap.status === 'fulfilled' && !mindSnap.value.empty) {
      const checkins = mindSnap.value.docs.map(d => d.data());
      todayMoodAvg    = checkins.reduce((s, c) => s + (c.mood_score || 2), 0) / checkins.length;
      todayMaxAnxiety = Math.max(...checkins.map(c => c.anxiety || 1));
    }

    let lastWorkoutDate    = null;
    let lastWorkoutMuscles = null;
    let trainingToday      = false;
    if (fitnessSnap.status === 'fulfilled' && fitnessSnap.value?.logs?.length) {
      const fw = fitnessSnap.value.logs[0];
      lastWorkoutDate    = fw.date_str || null;
      lastWorkoutMuscles = Array.isArray(fw.muscle_groups)
        ? fw.muscle_groups.join(', ')
        : (fw.muscle_groups || null);
      trainingToday = lastWorkoutDate === today;
    }

    return {
      lastSleepHours, lastSleepDate,
      todayMoodAvg, todayMaxAnxiety,
      lastWorkoutDate, lastWorkoutMuscles, trainingToday,
    };
  } catch { return {}; }
}

// ─── Nutrition LLM context builder ───────────────────────────
async function buildNutritionContext(deviceId) {
  const today = dateStr();
  const [nutSnap, profileSnap, todayLogsSnap, recentLogsSnap] = await Promise.all([
    nutDoc(deviceId).get(),
    userDoc(deviceId).get(),
    logsCol(deviceId).where('date_str', '==', today).get(),
    logsCol(deviceId).orderBy('logged_at', 'desc').limit(50).get(),
  ]);

  const setup   = nutSnap.exists ? nutSnap.data() : {};
  const profile = profileSnap.exists ? profileSnap.data() : {};
  const name    = profile.name || 'there';

  const todayLogs   = todayLogsSnap.docs.map(mapSnapDoc);
  const recentLogs  = recentLogsSnap.docs.map(mapSnapDoc);

  const calsToday  = todayLogs.reduce((s, l) => s + (l.calories || 0), 0);
  const protToday  = todayLogs.reduce((s, l) => s + (l.protein || 0), 0);
  const carbsToday = todayLogs.reduce((s, l) => s + (l.carbs || 0), 0);
  const fatToday   = todayLogs.reduce((s, l) => s + (l.fat || 0), 0);
  const waterToday = setup.water_today === today ? (setup.water_cups_today || 0) : 0;

  const calTarget  = setup.calorie_target || 2000;
  const protTarget = setup.protein_target || 140;
  const carbTarget = setup.carb_target    || 220;
  const fatTarget  = setup.fat_target     || 65;

  const todayLogStr = todayLogs.length
    ? todayLogs.map(l => `  • ${l.food_name} (${l.meal_type}): ${l.calories}kcal P${Math.round(l.protein||0)}g C${Math.round(l.carbs||0)}g F${Math.round(l.fat||0)}g`).join('\n')
    : '  Nothing logged yet today';

  // 7-day pattern
  const last7Days = {};
  recentLogs.forEach(l => {
    if (!last7Days[l.date_str]) last7Days[l.date_str] = { cals: 0, prot: 0, days: 1 };
    last7Days[l.date_str].cals += l.calories || 0;
    last7Days[l.date_str].prot += l.protein  || 0;
  });
  const daysLogged = Object.keys(last7Days).filter(d => d >= dateStr(new Date(Date.now() - 7 * 86400000)));
  const avgCals7d  = daysLogged.length ? Math.round(daysLogged.reduce((s, d) => s + last7Days[d].cals, 0) / daysLogged.length) : null;
  const protHitDays = daysLogged.filter(d => last7Days[d].prot >= protTarget * 0.9).length;

  // Cross-agent data
  const { lastSleepHours, lastSleepDate, todayMoodAvg, todayMaxAnxiety, lastWorkoutDate, lastWorkoutMuscles, trainingToday } = await getCrossAgentData(deviceId);

  const sleepLine = lastSleepHours
    ? `Last logged sleep (${lastSleepDate}): ${lastSleepHours.toFixed(1)}h${lastSleepHours < 6 ? ' — SHORT SLEEP: cortisol elevated, expect higher hunger and carb cravings today. Prioritise protein and fibre to stabilise appetite.' : lastSleepHours >= 8 ? ' — Great recovery sleep, anabolic window is optimal.' : ''}`
    : 'No sleep data available';

  const mindLine = todayMaxAnxiety && todayMaxAnxiety >= 4
    ? `TODAY: Anxiety spiked to ${todayMaxAnxiety}/5 — STRESS-EATING RISK. Cortisol spikes cravings for high-fat/high-sugar foods. Proactively suggest protein-forward options to stabilise blood sugar.`
    : todayMoodAvg
    ? `Today's mood average: ${todayMoodAvg.toFixed(1)}/4 — no elevated stress signals`
    : 'No Mind Coach data today';

  const fitnessLine = trainingToday
    ? `TRAINED TODAY: worked ${lastWorkoutMuscles || 'full body'} — protein needs elevated by ~20%. Prioritise hitting protein target today for muscle protein synthesis window.`
    : lastWorkoutDate && lastWorkoutDate >= dateStr(new Date(Date.now() - 2 * 86400000))
    ? `Trained recently (${lastWorkoutDate}): ${lastWorkoutMuscles || 'workout'} — still in recovery window, protein timing matters.`
    : 'No recent workout data';

  return `You are the Nutrition Coach in Pulse — a deeply personal AI nutrition coach. You are not ChatGPT. You have been privately observing ${name}'s eating patterns and you know their data in detail.

Your rule: if you say something a stranger could have said, you have failed. Every sentence must reflect their specific data, their specific goals, their specific patterns.

━━━ WHO THEY ARE ━━━
Name: ${name}
Goal: ${setup.goal || 'eat healthier'}
Dietary style: ${Array.isArray(setup.dietary_style) ? setup.dietary_style.join(', ') : (setup.dietary_style || 'no restrictions')}
Biggest challenge: ${Array.isArray(setup.biggest_challenge) ? setup.biggest_challenge.join(', ') : (setup.biggest_challenge || 'general nutrition')}
Allergies: ${(setup.allergies || []).join(', ') || 'none'}
Eating pattern: ${setup.eating_pattern || '3 meals a day'}

━━━ TODAY'S LOG ━━━
Calories: ${Math.round(calsToday)} / ${calTarget} kcal (${Math.round(calsToday/calTarget*100)}% of target)
Protein:  ${Math.round(protToday)}g / ${protTarget}g
Carbs:    ${Math.round(carbsToday)}g / ${carbTarget}g
Fat:      ${Math.round(fatToday)}g / ${fatTarget}g
Water:    ${waterToday}/${setup.water_target_cups || 8} cups
Remaining: ${Math.max(0, calTarget - Math.round(calsToday))} kcal | ${Math.max(0, protTarget - Math.round(protToday))}g protein

Today's food log:
${todayLogStr}

━━━ DAILY TARGETS ━━━
Calories: ${calTarget} kcal
Protein: ${protTarget}g | Carbs: ${carbTarget}g | Fat: ${fatTarget}g

━━━ LAST 7 DAYS PATTERN ━━━
Days logged: ${daysLogged.length}/7
Average calories: ${avgCals7d ? `${avgCals7d} kcal/day` : 'not enough data'}
Protein goal hit: ${protHitDays}/${daysLogged.length} days

━━━ CROSS-AGENT INTELLIGENCE (your superpower — use it explicitly) ━━━
SLEEP:   ${sleepLine}
MIND:    ${mindLine}
FITNESS: ${fitnessLine}

━━━ COACHING RULES ━━━
1. NEVER use: bad, cheat, guilty, indulge, allowed, naughty, treat, slip, fail
2. Never imply they've failed. Going over target = "adjust tomorrow" not "you blew it"
3. Reference exact numbers from their log. A stranger could never say what you say.
4. Cross-agent connections are your superpower — if sleep was short or anxiety was high today, address it directly and proactively
5. Protein is the most important macro — prioritize it in suggestions
6. Keep responses tight: 2-4 sentences + 1 actionable suggestion unless they want a full plan
7. If they ask what to eat next, check remaining macros and give specific suggestions that fit exactly
8. Be warm and direct. Not clinical. Not fake-cheerful.`;
}

// ═══════════════════════════════════════════════════════════════
// POST /setup
// ═══════════════════════════════════════════════════════════════
// Convert onboarding ageGroup ("25-34") to midpoint age for BMR
function ageGroupToYears(ageGroup) {
  const map = { '18-24': 21, '25-34': 29, '35-44': 39, '45-54': 49, '55-64': 59, '65+': 68 };
  return map[ageGroup] || 30;
}

// Normalise onboarding gender ("Male"/"Female") → BMR key
function normaliseGender(g) {
  if (!g) return 'other';
  const v = g.toLowerCase();
  if (v === 'male')   return 'male';
  if (v === 'female') return 'female';
  return 'other';
}

router.post('/setup', async (req, res) => {
  try {
    const {
      deviceId, goal, dietary_style, biggest_challenge,
      activity_level, eating_pattern, allergies,
      weight_kg, height_cm,
    } = req.body;

    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    // Read existing profile — name, ageGroup, gender already collected at onboarding
    const profileSnap = await userDoc(deviceId).get();
    const profile     = profileSnap.exists ? profileSnap.data() : {};
    const firstName   = (profile.name || profile.displayName || '').split(' ')[0];
    const age_years   = ageGroupToYears(profile.ageGroup || profile.age_group);
    const gender      = normaliseGender(profile.gender);

    const targets = calcTargets({ goal, activity_level, weight_kg, height_cm, age_years, gender });

    const setupData = {
      setup_completed:       true,
      goal:                  goal                || 'healthier',
      dietary_style:         dietary_style       || 'no_restrictions',
      biggest_challenge:     biggest_challenge   || '',
      activity_level:        activity_level      || 'moderate',
      eating_pattern:        eating_pattern      || '3_meals',
      allergies:             allergies           || [],
      weight_kg:             weight_kg           || null,
      height_cm:             height_cm           || null,
      age_years,
      gender,
      ...targets,
      streak:                0,
      last_log_date:         null,
      last_proactive_date:   null,
      proactive_topic_week:  null,
      proactive_topic_week_count: 0,
      created_at:            admin.firestore.FieldValue.serverTimestamp(),
    };

    await nutDoc(deviceId).set(setupData, { merge: true });
    await userDoc(deviceId).set({
      nutrition_setup_complete: true,
      nutrition_setup_at: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Opening chat message — uses real name from profile
    const greeting    = firstName ? `Hey ${firstName} 👋` : 'Hey';
    const openingMsg  = `${greeting} — your Nutrition Coach is ready. I've pulled in your profile so we're already calibrated to your body. Your daily target is ${targets.calorie_target} kcal with ${targets.protein_target}g protein — built for you, not a generic template. Log your first meal and I'll start reading your patterns. What did you eat last?`;

    await chatsCol(deviceId).add({
      role:           'assistant',
      content:        openingMsg,
      is_proactive:   false,
      proactive_type: null,
      is_read:        true,
      created_at:     admin.firestore.FieldValue.serverTimestamp(),
    });

    // Queue v2 welcome action batch (shared engine)
    try { _v2Hooks.queueGeneration(deviceId, { generationKind: 'setup' }); } catch {}

    res.json({ success: true, targets });
  } catch (err) {
    console.error('[nutrition] /setup error:', err);
    res.status(500).json({ error: 'Setup failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /setup-status
// ═══════════════════════════════════════════════════════════════
router.get('/setup-status', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const snap = await nutDoc(deviceId).get();
    if (!snap.exists) return res.json({ setup_completed: false });
    res.json({ setup_completed: !!snap.data().setup_completed, setup: snap.data() });
  } catch (err) {
    console.error('[nutrition] /setup-status error:', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat-prompts  — returns 6 prompts personalised from setup + logs
// ═══════════════════════════════════════════════════════════════
router.get('/chat-prompts', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap  = await nutDoc(deviceId).get();
    const setup = snap.exists ? snap.data() : {};
    const goal      = setup.goal              || 'healthier';
    const diet      = setup.dietary_style     || 'no_restrictions';
    const challenge = setup.biggest_challenge || '';
    const activity  = setup.activity_level    || 'moderate';
    const pattern   = setup.eating_pattern    || '3_meals';

    const lastSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(1).get();
    const lastLog  = lastSnap.empty ? null : lastSnap.docs[0].data();

    const hour = new Date().getHours();
    const isMorning = hour >= 5 && hour < 12;
    const isLunch   = hour >= 11 && hour < 14;
    const isDinner  = hour >= 17 && hour < 21;

    const pool = [];

    if (goal === 'weight_loss') {
      pool.push({ emoji: '🎯', text: "Am I in a deficit today? Show me my calorie balance." });
      pool.push({ emoji: '🥗', text: "What's a filling low-calorie meal for right now?" });
    } else if (goal === 'muscle_gain') {
      pool.push({ emoji: '💪', text: "Am I hitting enough protein to build muscle?" });
      pool.push({ emoji: '⚡', text: "What should I eat before and after training?" });
    } else if (goal === 'energy') {
      pool.push({ emoji: '⚡', text: "Why do I crash in the afternoon and how do I fix it?" });
      pool.push({ emoji: '🍽️', text: "What foods give sustained energy all day?" });
    } else {
      pool.push({ emoji: '🥗', text: "How can I make my diet healthier without big changes?" });
      pool.push({ emoji: '📊', text: "What nutrients am I consistently missing?" });
    }

    if (diet === 'vegan' || diet === 'vegetarian') {
      pool.push({ emoji: '🌱', text: "How do I get enough protein on a plant-based diet?" });
    } else if (diet === 'keto' || diet === 'low_carb') {
      pool.push({ emoji: '🥑', text: "Am I staying in ketosis with my current eating?" });
    } else if (diet === 'paleo') {
      pool.push({ emoji: '🍖', text: "Give me paleo meal ideas that fit my macros." });
    }

    if (challenge === 'cravings') {
      pool.push({ emoji: '🍫', text: "I'm having intense cravings right now — help." });
    } else if (challenge === 'consistency') {
      pool.push({ emoji: '📅', text: "How do I stay consistent with healthy eating?" });
    } else if (challenge === 'portion_control') {
      pool.push({ emoji: '🍽️', text: "I struggle with portion sizes. Any tricks?" });
    }

    if (isMorning)    pool.push({ emoji: '🌅', text: "What's the best breakfast for my goal today?" });
    else if (isLunch) pool.push({ emoji: '🥙', text: "What should I eat for lunch right now?" });
    else if (isDinner)pool.push({ emoji: '🍽️', text: "Plan a dinner that keeps me on track tonight." });

    if (lastLog && lastLog.protein_g && lastLog.protein_g < (setup.protein_g_target || 100) * 0.6) {
      pool.unshift({ emoji: '🥩', text: "My protein is low today — easy high-protein options?" });
    }

    pool.push({ emoji: '📊', text: "What's my nutrition summary for this week?" });
    pool.push({ emoji: '🔄', text: "How does my nutrition affect my energy and sleep?" });

    res.json({ prompts: pool.slice(0, 6) });
  } catch (err) {
    console.error('[nutrition] /chat-prompts error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ─── Food Quality scoring (0-100, deterministic from macros + name) ──────
// Higher = nutrient-dense, lower = ultra-processed. No AI call needed.
function _computeFoodQuality({ calories = 0, protein = 0, carbs = 0, fat = 0, food_name = '' }) {
  if (calories < 5) return 50;
  const totalMacroCal = protein * 4 + carbs * 4 + fat * 9;
  if (totalMacroCal < 5) return 50;

  // 1. Protein density (g/100kcal): >=8 elite, 5-8 great, 3-5 ok, <3 low
  const pDensity = (protein * 100) / Math.max(calories, 1);
  let pScore = pDensity >= 8 ? 100 : pDensity >= 5 ? 80 : pDensity >= 3 ? 60 : pDensity >= 1.5 ? 40 : 20;

  // 2. Macro balance — penalize extreme skew (e.g., pure sugar = high carb only)
  const pCal = protein * 4, cCal = carbs * 4, fCal = fat * 9;
  const minCal = Math.min(pCal, cCal, fCal);
  const balanceRatio = minCal / totalMacroCal;
  let bScore = balanceRatio >= 0.20 ? 100 : balanceRatio >= 0.12 ? 75 : balanceRatio >= 0.05 ? 50 : 30;

  // 3. Name-based heuristic — penalize known junk, reward whole foods
  const name = (food_name || '').toLowerCase();
  const junkPatterns = /\b(soda|coke|pepsi|sprite|candy|chip|crisp|donut|doughnut|cookie|cake|pastry|fries|burger king|mcdonald|kfc|cheeto|dorito|pop ?tart|ice cream|gummy|sugar|syrup|sweetened)\b/;
  const wholePatterns = /\b(salmon|chicken breast|tuna|cod|tilapia|egg|broccoli|spinach|kale|quinoa|oats|oatmeal|lentil|bean|chickpea|tofu|tempeh|sweet potato|brown rice|avocado|berries|blueberr|strawberr|nuts|almond|walnut|greek yogurt|cottage cheese|sardine)\b/;
  let nScore = 60;
  if (junkPatterns.test(name)) nScore = 25;
  if (wholePatterns.test(name)) nScore = 95;

  // Weighted blend: 50% protein density, 25% balance, 25% name signal
  const score = Math.round(pScore * 0.50 + bScore * 0.25 + nScore * 0.25);
  return Math.max(0, Math.min(100, score));
}

async function refreshNutritionScore(deviceId) {
  try {
    const [logsSnap, nutSnap] = await Promise.all([
      logsCol(deviceId).where('date_str', '>=', (() => {
        const d = new Date(); d.setDate(d.getDate() - 8);
        return d.toISOString().slice(0, 10);
      })()).get(),
      nutDoc(deviceId).get(),
    ]);
    const setup = nutSnap.data() || {};
    const calTarget  = setup.calorie_target || 2000;
    const protTarget = setup.protein_target || 140;
    const streak     = setup.streak || 0;

    // Group by date
    const byDate = {};
    logsSnap.docs.forEach(d => {
      const data = d.data();
      if (!byDate[data.date_str]) byDate[data.date_str] = { cals: 0, protein: 0, carbs: 0, fat: 0 };
      byDate[data.date_str].cals    += data.calories || 0;
      byDate[data.date_str].protein += data.protein  || 0;
      byDate[data.date_str].carbs   += data.carbs    || 0;
      byDate[data.date_str].fat     += data.fat      || 0;
    });

    const dates = Object.keys(byDate);
    if (!dates.length) return;
    const daysLogged = dates.length;
    const recent7 = dates.slice(-7);

    // Partial adherence — score reflects PROGRESS toward target, not just binary hit.
    // calorie: 0% at 0 logged, 100% at 90-110% of target, decays back to 0 over 130%.
    const calProgress = recent7.map(d => {
      const r = byDate[d].cals / calTarget;
      if (r >= 0.9 && r <= 1.1) return 100;
      if (r < 0.9)              return Math.round((r / 0.9) * 100);
      if (r > 1.3)              return 0;
      return Math.round(100 - ((r - 1.1) / 0.2) * 100);
    });
    const protProgress = recent7.map(d =>
      Math.round(Math.min(byDate[d].protein / (protTarget || 1), 1) * 100)
    );
    const n = recent7.length || 1;
    const avgP   = recent7.reduce((s, d) => s + byDate[d].protein, 0) / n;
    const avgC   = recent7.reduce((s, d) => s + byDate[d].carbs, 0) / n;
    const avgF   = recent7.reduce((s, d) => s + byDate[d].fat, 0) / n;
    const totalMacroCal = avgP * 4 + avgC * 4 + avgF * 9;
    const macroBalance  = totalMacroCal > 100
      ? Math.min((Math.min(avgP * 4, avgC * 4, avgF * 9) / totalMacroCal) / 0.2, 1) * 100 : 50;

    const result = _computeNutritionScore({
      calorie_adherence: Math.round(calProgress.reduce((a, b) => a + b, 0) / calProgress.length),
      protein_adherence: Math.round(protProgress.reduce((a, b) => a + b, 0) / protProgress.length),
      streak,
      macro_balance: Math.round(macroBalance),
      days_logged: daysLogged,
    });
    if (!result) return;

    await nutDoc(deviceId).update({
      current_score:    result.score,
      score_label:      result.label,
      score_components: result.components,
      score_updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[nutrition] refreshScore:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// POST /log — add a food item
// ═══════════════════════════════════════════════════════════════
router.post('/log', async (req, res) => {
  try {
    const {
      deviceId, calories, protein, carbs, fat,
      quantity, unit, food_id, source, date_str: logDate, emoji,
    } = req.body;
    const food_name = req.body.food_name || req.body.name;
    const meal_type = req.body.meal_type || req.body.meal || 'snack';

    if (!deviceId || !food_name) return res.status(400).json({ error: 'deviceId and food_name required' });

    const today = logDate || dateStr();
    const cal = Math.round(calories || 0);
    const p   = Math.round((protein || 0) * 10) / 10;
    const c   = Math.round((carbs || 0) * 10) / 10;
    const f   = Math.round((fat || 0) * 10) / 10;
    const food_quality_score = _computeFoodQuality({ calories: cal, protein: p, carbs: c, fat: f, food_name });

    const ref = await logsCol(deviceId).add({
      food_name,
      emoji:     emoji || '🍽️',
      meal_type: meal_type || 'snack',
      calories:  cal,
      protein:   p,
      carbs:     c,
      fat:       f,
      quantity:  quantity || 100,
      unit:      unit || 'g',
      food_id:   food_id || null,
      source:    source || 'manual',
      date_str:  today,
      food_quality_score,
      logged_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update streak
    const nutSnap = await nutDoc(deviceId).get();
    const nutData = nutSnap.data() || {};
    const lastLog = nutData.last_log_date;
    const yesterday = dateStr(new Date(Date.now() - 86400000));
    const newStreak = (lastLog === yesterday || lastLog === today)
      ? (lastLog === today ? (nutData.streak || 1) : (nutData.streak || 0) + 1)
      : 1;

    await nutDoc(deviceId).set({
      last_log_date: today,
      streak:        newStreak,
    }, { merge: true });

    // Low calorie safety check — 3+ days under 800 kcal (max 1 proactive/day)
    if (nutData.last_proactive_date !== today) {
      const recentDaysSnap = await logsCol(deviceId)
        .where('date_str', '>=', dateStr(new Date(Date.now() - 3 * 86400000)))
        .get();
      const byDay = {};
      recentDaysSnap.docs.forEach(d => {
        const data = d.data();
        if (!byDay[data.date_str]) byDay[data.date_str] = 0;
        byDay[data.date_str] += data.calories || 0;
      });
      const lowDays = Object.values(byDay).filter(c => c < 800 && c > 0).length;
      if (lowDays >= 3) {
        const lowMsg = "I've noticed you've been eating quite lightly the last few days. How are you feeling energy-wise? I want to make sure your targets are set right for your goals — nothing to fix, just want to check in.";
        await chatsCol(deviceId).add({
          role: 'assistant', content: lowMsg, is_proactive: true,
          proactive_type: 'low_intake_check', is_read: false, date_str: today,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        await nutDoc(deviceId).update({ last_proactive_date: today });
      }
    }

    _onNutritionLog(deviceId);  // v2 Actions hook
    refreshNutritionScore(deviceId).catch(() => {});

    // ── Publish nutrition_snapshot for cross-agent reads ─────────
    // Done async — don't block the response
    setImmediate(async () => {
      try {
        const todayLogsSnap = await logsCol(deviceId).where('date_str', '==', today).get();
        const todayTotals   = todayLogsSnap.docs.reduce((acc, d) => {
          const data = d.data();
          return {
            calories: acc.calories + (data.calories || 0),
            protein:  acc.protein  + (data.protein  || 0),
          };
        }, { calories: 0, protein: 0 });

        const calTarget  = nutData.calorie_target  || 2000;
        const protTarget = nutData.protein_target  || 140;

        // Also get last meal time for sleep agent
        const lastLogSnap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(1).get();
        const lastMealIso = lastLogSnap.empty ? null
          : lastLogSnap.docs[0].data().logged_at?.toDate?.()?.toISOString() || null;

        await nutDoc(deviceId).set({
          nutrition_snapshot: {
            last_log_date:      today,
            calories_today:     Math.round(todayTotals.calories),
            protein_today:      Math.round(todayTotals.protein * 10) / 10,
            calorie_target:     calTarget,
            protein_target:     protTarget,
            calorie_deficit:    Math.round(todayTotals.calories - calTarget),
            protein_hit_today:  todayTotals.protein >= protTarget * 0.9,
            last_meal_time_iso: lastMealIso,
            snapshot_at:        new Date().toISOString(),
          },
        }, { merge: true });
      } catch { /* non-fatal */ }
    });

    res.json({ success: true, id: ref.id, streak: newStreak });
  } catch (err) {
    console.error('[nutrition] /log error:', err);
    res.status(500).json({ error: 'Log failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /logs — get logs for a date
// ═══════════════════════════════════════════════════════════════
router.get('/logs', async (req, res) => {
  try {
    const { deviceId, date } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const targetDate = date || dateStr();
    const snap = await logsCol(deviceId).where('date_str', '==', targetDate).get();

    const logs = snap.docs.map(d => {
      const data = d.data();
      // Backfill food_quality_score for legacy logs missing it
      const fq = data.food_quality_score != null
        ? data.food_quality_score
        : _computeFoodQuality({
            calories: data.calories || 0,
            protein:  data.protein  || 0,
            carbs:    data.carbs    || 0,
            fat:      data.fat      || 0,
            food_name: data.food_name || '',
          });
      return {
        ...mapSnapDoc(d),
        food_quality_score: fq,
        logged_at: toIsoString(data.logged_at),
      };
    }).sort((a, b) => (a.logged_at || '') > (b.logged_at || '') ? 1 : -1);

    // Fetch targets + water + score cache
    const nutSnap = await nutDoc(deviceId).get();
    const nutData = nutSnap.data() || {};
    const waterCups = nutData.water_today === targetDate ? (nutData.water_cups_today || 0) : 0;

    const totals = logs.reduce((acc, l) => ({
      calories: acc.calories + (l.calories || 0),
      protein:  acc.protein  + (l.protein  || 0),
      carbs:    acc.carbs    + (l.carbs    || 0),
      fat:      acc.fat      + (l.fat      || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    // ── Hourly breakdown (24-hour calorie distribution for today) ──
    const hourlyBreakdown = Array(24).fill(0);
    logs.forEach(l => {
      if (!l.logged_at) return;
      const hr = new Date(l.logged_at).getHours();
      if (hr >= 0 && hr < 24) hourlyBreakdown[hr] += Math.round(l.calories || 0);
    });

    // ── Food quality average ──
    const food_quality_avg = logs.length
      ? Math.round(logs.reduce((s, l) => s + (l.food_quality_score || 0), 0) / logs.length)
      : null;

    // ── Total distinct days logged (for new-user gating) ──
    let days_logged = 0;
    try {
      const allLogsSnap = await logsCol(deviceId).select('date_str').get();
      const dateSet = new Set();
      allLogsSnap.docs.forEach(d => { const ds = d.data().date_str; if (ds) dateSet.add(ds); });
      days_logged = dateSet.size;
    } catch { /* non-fatal */ }

    res.json({
      logs,
      totals: {
        calories: Math.round(totals.calories),
        protein:  Math.round(totals.protein * 10) / 10,
        carbs:    Math.round(totals.carbs * 10) / 10,
        fat:      Math.round(totals.fat * 10) / 10,
      },
      water_cups: waterCups,
      targets: {
        calorie_target: nutData.calorie_target || 2000,
        protein_target: nutData.protein_target || 140,
        carb_target:    nutData.carb_target    || 220,
        fat_target:     nutData.fat_target     || 65,
        water_target_cups: nutData.water_target_cups || 8,
      },
      streak: nutData.streak || 0,
      days_logged,
      hourly_breakdown: hourlyBreakdown,
      food_quality_avg,
      nutrition_score:    nutData.current_score    || null,
      score_label:        nutData.score_label      || null,
      score_components:   nutData.score_components || null,
    });
  } catch (err) {
    console.error('[nutrition] /logs error:', err);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /today-context — lightweight snapshot for results sheet
// Returns today's totals + targets + streak (no log detail needed)
// ═══════════════════════════════════════════════════════════════
router.get('/today-context', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const today = dateStr();
    const [nutSnap, todaySnap] = await Promise.all([
      nutDoc(deviceId).get(),
      logsCol(deviceId).where('date_str', '==', today).get(),
    ]);
    const nutData = nutSnap.exists ? nutSnap.data() : {};
    const totals  = todaySnap.docs.reduce((acc, d) => {
      const data = d.data();
      return {
        calories: acc.calories + (data.calories || 0),
        protein:  acc.protein  + (data.protein  || 0),
      };
    }, { calories: 0, protein: 0 });

    res.json({
      calories_today:  Math.round(totals.calories),
      protein_today:   Math.round(totals.protein * 10) / 10,
      calorie_target:  nutData.calorie_target  || 2000,
      protein_target:  nutData.protein_target  || 140,
      streak:          nutData.streak          || 0,
    });
  } catch (err) {
    console.error('[nutrition] /today-context error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PATCH /log/:id — edit portion/quantity
// ═══════════════════════════════════════════════════════════════
router.patch('/log/:id', async (req, res) => {
  try {
    const { deviceId, quantity, calories, protein, carbs, fat } = req.body;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const updates = {};
    if (quantity !== undefined) updates.quantity  = quantity;
    if (calories !== undefined) updates.calories  = Math.round(calories);
    if (protein  !== undefined) updates.protein   = Math.round(protein  * 10) / 10;
    if (carbs    !== undefined) updates.carbs     = Math.round(carbs    * 10) / 10;
    if (fat      !== undefined) updates.fat       = Math.round(fat      * 10) / 10;

    await logsCol(deviceId).doc(id).update(updates);
    res.json({ success: true });
  } catch (err) {
    console.error('[nutrition] PATCH /log error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /log/:id
// ═══════════════════════════════════════════════════════════════
router.delete('/log/:id', async (req, res) => {
  try {
    const { deviceId } = req.query;
    const { id } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await logsCol(deviceId).doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error('[nutrition] DELETE /log error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /water — log a cup of water
// ═══════════════════════════════════════════════════════════════
router.post('/water', async (req, res) => {
  try {
    const { deviceId } = req.body;
    const cups_delta = req.body.cups_delta ?? req.body.delta ?? 1;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const today   = dateStr();
    const nutSnap = await nutDoc(deviceId).get();
    const nutData = nutSnap.data() || {};
    const existing = nutData.water_today === today ? (nutData.water_cups_today || 0) : 0;
    const newCups  = Math.max(0, existing + cups_delta);

    await nutDoc(deviceId).update({
      water_today:      today,
      water_cups_today: newCups,
    });

    res.json({ success: true, cups: newCups });
  } catch (err) {
    console.error('[nutrition] /water error:', err);
    res.status(500).json({ error: 'Water log failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /analysis
// ═══════════════════════════════════════════════════════════════
router.get('/analysis', async (req, res) => {
  try {
    const { deviceId, range = 'all' } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [nutSnap, allLogsSnap] = await Promise.all([
      nutDoc(deviceId).get(),
      logsCol(deviceId).orderBy('date_str', 'asc').limit(500).get(),
    ]);

    if (!nutSnap.exists) return res.json({ stage: 0 });

    const nutData = nutSnap.data();
    const allLogs = allLogsSnap.docs.map(mapSnapDoc);

    if (allLogs.length === 0) return res.json({ stage: 0, setup: nutData });

    // Range filter
    const RANGE_DAYS = { '7': 7, '30': 30, '90': 90, '365': 365, 'all': null };
    const days = RANGE_DAYS[range];
    const cutoff = days ? dateStr(new Date(Date.now() - days * 86400000)) : null;
    const filteredLogs = cutoff ? allLogs.filter(l => l.date_str >= cutoff) : allLogs;

    if (filteredLogs.length === 0) return res.json({ stage: 0, setup: nutData, empty_range: true });

    // Group by date
    const byDate = {};
    filteredLogs.forEach(l => {
      if (!byDate[l.date_str]) byDate[l.date_str] = { cals: 0, protein: 0, carbs: 0, fat: 0, items: 0 };
      byDate[l.date_str].cals    += l.calories || 0;
      byDate[l.date_str].protein += l.protein  || 0;
      byDate[l.date_str].carbs   += l.carbs    || 0;
      byDate[l.date_str].fat     += l.fat      || 0;
      byDate[l.date_str].items   += 1;
    });
    const dates = Object.keys(byDate).sort();
    const daysWithLogs = dates.length;

    // Stats
    const calTarget  = nutData.calorie_target || 2000;
    const protTarget = nutData.protein_target || 140;
    const avgCals    = Math.round(dates.reduce((s, d) => s + byDate[d].cals, 0) / daysWithLogs);
    const avgProt    = Math.round(dates.reduce((s, d) => s + byDate[d].protein, 0) / daysWithLogs * 10) / 10;
    const avgCarbs   = Math.round(dates.reduce((s, d) => s + byDate[d].carbs, 0) / daysWithLogs * 10) / 10;
    const avgFat     = Math.round(dates.reduce((s, d) => s + byDate[d].fat, 0) / daysWithLogs * 10) / 10;
    const maxCals    = Math.round(Math.max(...dates.map(d => byDate[d].cals)));
    const minCals    = Math.round(Math.min(...dates.map(d => byDate[d].cals)));
    const protHitDays = dates.filter(d => byDate[d].protein >= protTarget * 0.9).length;
    const calsOnTargetDays = dates.filter(d => {
      const c = byDate[d].cals;
      return c >= calTarget * 0.85 && c <= calTarget * 1.15;
    }).length;

    // Signal points for charts
    const signalPoints = buildSignalPoints(byDate, dates, range);

    // Streak
    const streak = nutData.streak || 0;

    // Most logged foods
    const foodCounts = {};
    filteredLogs.forEach(l => {
      const key = l.food_name?.toLowerCase() || 'unknown';
      foodCounts[key] = (foodCounts[key] || 0) + 1;
    });
    const topFoods = Object.entries(foodCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Cross-agent insights (only when range includes enough data)
    let crossAgentInsights = null;
    if (range === 'all' || range === '30') {
      crossAgentInsights = await buildCrossAgentInsights(deviceId, allLogs, nutData);
    }

    // AI insight (cached, only for 'all' range with enough data)
    let ai_insight = null;
    if (range === 'all' && daysWithLogs >= 5) {
      const cacheKey = `${daysWithLogs}_${Math.round(avgCals)}`;
      const cached   = nutData.analysis_cache;
      if (cached && cached.key === cacheKey) {
        ai_insight = cached.insight;
      } else {
        ai_insight = await generateAnalysisInsight(nutData, { avgCals, avgProt, calTarget, protTarget, daysWithLogs, protHitDays, calsOnTargetDays, topFoods });
        await nutDoc(deviceId).update({
          analysis_cache: { key: cacheKey, insight: ai_insight, generated_at: new Date().toISOString() },
        });
      }
    }

    // ── Nutrition Score — use shared agent-scores formula for cross-screen consistency ──
    const _scoreDays = Math.min(daysWithLogs, 7);
    const _recentDates = dates.slice(-_scoreDays);
    // Partial progress (matches refreshNutritionScore)
    const _calProgress = _recentDates.map(d => {
      const r = byDate[d].cals / calTarget;
      if (r >= 0.9 && r <= 1.1) return 100;
      if (r < 0.9)              return Math.round((r / 0.9) * 100);
      if (r > 1.3)              return 0;
      return Math.round(100 - ((r - 1.1) / 0.2) * 100);
    });
    const _protProgress = _recentDates.map(d =>
      Math.round(Math.min(byDate[d].protein / (protTarget || 1), 1) * 100)
    );
    const totalMacroCal = avgProt * 4 + avgCarbs * 4 + avgFat * 9;
    const _macroBalance = totalMacroCal > 100
      ? Math.min((Math.min(avgProt * 4, avgCarbs * 4, avgFat * 9) / totalMacroCal) / 0.2, 1) * 100
      : 0;
    const nutrition_score = _computeNutritionScore({
      calorie_adherence: _calProgress.length ? Math.round(_calProgress.reduce((a,b)=>a+b,0) / _calProgress.length) : 0,
      protein_adherence: _protProgress.length ? Math.round(_protProgress.reduce((a,b)=>a+b,0) / _protProgress.length) : 0,
      macro_balance:     Math.round(_macroBalance),
      streak:            nutData.streak || 0,
      days_logged:       daysWithLogs,
    }) || {
      score: 0, label: 'Starting',
      components: { calorie_adherence: 0, protein_adherence: 0, consistency: 0, macro_balance: 0 },
    };

    // ── 28-day heatmap (always from allLogs, range-independent) ──
    const heatmap_days = [];
    for (let i = 27; i >= 0; i--) {
      const ds      = dateStr(new Date(Date.now() - i * 86400000));
      const dayCals = allLogs.filter(l => l.date_str === ds).reduce((s, l) => s + (l.calories || 0), 0);
      heatmap_days.push({
        date_str: ds,
        calories: Math.round(dayCals),
        adherence: calTarget > 0 ? Math.round((dayCals / calTarget) * 100) / 100 : 0,
        logged: dayCals > 0,
      });
    }

    // ── Meal timing breakdown ─────────────────────────────────────
    const mealTotals = {}, mealDaySets = {};
    allLogs.forEach(l => {
      const m = (l.meal_type || 'snacks').toLowerCase();
      mealTotals[m]  = (mealTotals[m]  || 0) + (l.calories || 0);
      if (!mealDaySets[m]) mealDaySets[m] = new Set();
      mealDaySets[m].add(l.date_str);
    });
    const meal_timing = Object.keys(mealTotals)
      .map(m => ({ meal: m, avg_calories: Math.round(mealTotals[m] / (mealDaySets[m].size || 1)) }))
      .sort((a, b) => b.avg_calories - a.avg_calories);

    const stage = daysWithLogs >= 14 ? 3 : daysWithLogs >= 5 ? 2 : 1;

    res.json({
      stage,
      stats: {
        days_logged: daysWithLogs,
        avg_calories: avgCals,
        avg_protein: avgProt,
        avg_carbs: avgCarbs,
        avg_fat: avgFat,
        max_calories: maxCals,
        min_calories: minCals,
        calorie_target: calTarget,
        protein_target: protTarget,
        protein_hit_days: protHitDays,
        on_target_days: calsOnTargetDays,
        streak,
        top_foods: topFoods,
      },
      nutrition_score,
      heatmap_days,
      meal_timing,
      signal_points: signalPoints,
      cross_agent_insights: crossAgentInsights,
      ai_insight,
      setup: nutData,
    });
  } catch (err) {
    console.error('[nutrition] /analysis error:', err);
    res.status(500).json({ error: 'Analysis failed' });
  }
});

function buildSignalPoints(byDate, dates, range) {
  if (range === '7' || range === '30') {
    // Daily points
    return dates.map(ds => {
      const d = new Date(ds + 'T12:00:00');
      return {
        date_str: ds,
        label:    d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
        calories: Math.round(byDate[ds].cals),
        protein:  Math.round(byDate[ds].protein * 10) / 10,
      };
    });
  } else if (range === '90') {
    // Weekly buckets
    const weeks = {};
    dates.forEach(ds => {
      const d    = new Date(ds + 'T12:00:00');
      const diff = (d.getDay() + 6) % 7;
      const mon  = new Date(d); mon.setDate(d.getDate() - diff);
      const key  = `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
      if (!weeks[key]) weeks[key] = { cals: 0, protein: 0, days: 0 };
      weeks[key].cals    += byDate[ds].cals;
      weeks[key].protein += byDate[ds].protein;
      weeks[key].days    += 1;
    });
    return Object.keys(weeks).sort().map(wk => {
      const d = new Date(wk + 'T12:00:00');
      return {
        date_str: wk,
        label:    d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
        calories: Math.round(weeks[wk].cals / weeks[wk].days),
        protein:  Math.round(weeks[wk].protein / weeks[wk].days * 10) / 10,
      };
    });
  } else {
    // Monthly buckets
    const months = {};
    dates.forEach(ds => {
      const key = ds.substring(0, 7);
      if (!months[key]) months[key] = { cals: 0, protein: 0, days: 0 };
      months[key].cals    += byDate[ds].cals;
      months[key].protein += byDate[ds].protein;
      months[key].days    += 1;
    });
    return Object.keys(months).sort().map(mk => {
      const d = new Date(mk + '-01T12:00:00');
      return {
        date_str: mk,
        label:    d.toLocaleDateString('en', { month: 'short', year: '2-digit' }),
        calories: Math.round(months[mk].cals / months[mk].days),
        protein:  Math.round(months[mk].protein / months[mk].days * 10) / 10,
      };
    });
  }
}

async function buildCrossAgentInsights(deviceId, allLogs, nutData) {
  try {
    const insights = [];

    // Sleep-nutrition correlation
    const sleepLogsSnap = await userDoc(deviceId)
      .collection('agents').doc('sleep')
      .collection('sleep_logs').orderBy('date_str', 'desc').limit(30).get();

    if (!sleepLogsSnap.empty) {
      const sleepByDate = {};
      sleepLogsSnap.docs.forEach(d => {
        const s = d.data();
        if (s.date_str) sleepByDate[s.date_str] = s.total_sleep_hours || 0;
      });

      const nutritionByDate = {};
      allLogs.forEach(l => {
        if (!nutritionByDate[l.date_str]) nutritionByDate[l.date_str] = 0;
        nutritionByDate[l.date_str] += l.calories || 0;
      });

      const matched = Object.keys(sleepByDate).filter(d => nutritionByDate[d]);
      const shortSleep = matched.filter(d => sleepByDate[d] < 6);
      const normalSleep = matched.filter(d => sleepByDate[d] >= 7);

      if (shortSleep.length >= 3 && normalSleep.length >= 3) {
        const shortAvg  = Math.round(shortSleep.reduce((s, d) => s + nutritionByDate[d], 0) / shortSleep.length);
        const normalAvg = Math.round(normalSleep.reduce((s, d) => s + nutritionByDate[d], 0) / normalSleep.length);
        const diff = shortAvg - normalAvg;
        if (Math.abs(diff) > 100) {
          insights.push({
            type:  'sleep_nutrition',
            icon:  '💤',
            title: 'Sleep affects your eating',
            body:  `On nights you slept under 6 hours, you ate an average ${Math.abs(diff)} kcal more the next day vs. well-rested nights. That's cortisol — not willpower.`,
            color: '#60A5FA',
          });
        }
      }
    }

    // Mind-nutrition correlation (stress eating)
    const mindLogsSnap = await userDoc(deviceId)
      .collection('agents').doc('mind')
      .collection('mind_checkins').orderBy('date_str', 'desc').limit(60).get();

    if (!mindLogsSnap.empty) {
      const highAnxDates = new Set();
      const normalDates  = new Set();
      mindLogsSnap.docs.forEach(d => {
        const c = d.data();
        if (c.anxiety >= 4) highAnxDates.add(c.date_str);
        else if (c.anxiety <= 2) normalDates.add(c.date_str);
      });

      const nutritionByDate = {};
      allLogs.forEach(l => {
        if (!nutritionByDate[l.date_str]) nutritionByDate[l.date_str] = 0;
        nutritionByDate[l.date_str] += l.calories || 0;
      });

      const stressDays  = [...highAnxDates].filter(d => nutritionByDate[d]);
      const calmDays    = [...normalDates].filter(d => nutritionByDate[d]);

      if (stressDays.length >= 3 && calmDays.length >= 3) {
        const stressAvg = Math.round(stressDays.reduce((s, d) => s + nutritionByDate[d], 0) / stressDays.length);
        const calmAvg   = Math.round(calmDays.reduce((s, d) => s + nutritionByDate[d], 0) / calmDays.length);
        const diff = stressAvg - calmAvg;
        if (diff > 150) {
          insights.push({
            type:  'stress_eating',
            icon:  '🧠',
            title: 'Stress drives your intake',
            body:  `On high-anxiety days logged in your Mind Coach, you average ${diff} more calories than on calm days. Knowing the pattern is the first step to planning around it.`,
            color: '#F59E0B',
          });
        }
      }
    }

    return insights.length ? insights : null;
  } catch { return null; }
}

async function generateAnalysisInsight(setup, stats) {
  const { avgCals, avgProt, calTarget, protTarget, daysWithLogs, protHitDays, calsOnTargetDays, topFoods } = stats;
  const protAdherence = daysWithLogs > 0 ? Math.round(protHitDays / daysWithLogs * 100) : 0;
  const calAdherence  = daysWithLogs > 0 ? Math.round(calsOnTargetDays / daysWithLogs * 100) : 0;
  const topFood       = topFoods[0]?.name || 'nothing yet';

  const prompt = `Generate a personal nutrition insight for someone's nutrition tracking app analysis page.

Data:
- Days logged: ${daysWithLogs}
- Average calories: ${avgCals} kcal (target: ${calTarget})
- Average protein: ${avgProt}g/day (target: ${protTarget}g)
- Protein goal adherence: ${protAdherence}%
- Calories on target: ${calAdherence}%
- Most logged food: ${topFood}
- Goal: ${setup.goal || 'eat healthier'}

Write 2-3 sentences. Be direct and specific. Reference the actual numbers. Sound like a coach who has been watching their data, not a generic app. No platitudes, no "keep it up", no empty encouragement.

Return ONLY the insight text, nothing else.`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.fast, temperature: 0.55, max_tokens: 180,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// POST /food/recognize — camera photo → GPT-4o Vision → per-item macros
// ═══════════════════════════════════════════════════════════════
router.post('/food/recognize', async (req, res) => {
  try {
    const { deviceId, imageBase64 } = req.body;
    if (!deviceId || !imageBase64) return res.status(400).json({ error: 'deviceId and imageBase64 required' });

    // Fetch user setup for context-aware accuracy
    let userContext = {};
    try {
      const nutSnap = await nutDoc(deviceId).get();
      const setup   = nutSnap.exists ? nutSnap.data() : {};
      const hour    = new Date().getHours();
      userContext = {
        dietaryStyle: setup.dietary_style || null,
        goal:         setup.goal || null,
        cuisineHint:  setup.cuisine_preference || null,
        mealTime:     hour < 10 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 18 ? 'afternoon' : 'dinner',
      };
    } catch { /* non-fatal — use default prompt */ }

    const result = await recognizeFood(imageBase64, userContext);
    if (result.is_label) return res.json({ items: [], is_label: true });

    const items = (result.items || []).map(item => ({
      ...item,
      calories: Math.round(item.calories || 0),
      protein:  Math.round((item.protein || 0) * 10) / 10,
      carbs:    Math.round((item.carbs   || 0) * 10) / 10,
      fat:      Math.round((item.fat     || 0) * 10) / 10,
    }));

    res.json({ items, confidence_note: result.confidence_note || null });
  } catch (err) {
    console.error('[nutrition] /food/recognize error:', err);
    if (err.statusCode === 413) return res.status(413).json({ error: 'Image too large — please use a smaller photo' });
    res.status(500).json({ error: 'Food recognition failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /food/scan-label — nutrition label photo → exact macros
// ═══════════════════════════════════════════════════════════════
router.post('/food/scan-label', async (req, res) => {
  try {
    const { deviceId, imageBase64 } = req.body;
    if (!deviceId || !imageBase64) return res.status(400).json({ error: 'deviceId and imageBase64 required' });

    const result = await scanNutritionLabel(imageBase64);

    if (result.error) return res.status(422).json({ error: result.error });

    res.json({
      food_name:           result.food_name        || 'Scanned food',
      serving_description: result.serving_description || null,
      serving_size_g:      result.serving_size_g   || 100,
      calories:            Math.round(result.calories || 0),
      protein:             Math.round((result.protein || 0) * 10) / 10,
      carbs:               Math.round((result.carbs   || 0) * 10) / 10,
      fat:                 Math.round((result.fat     || 0) * 10) / 10,
      confidence:          result.confidence        || 'medium',
    });
  } catch (err) {
    console.error('[nutrition] /food/scan-label error:', err);
    res.status(500).json({ error: 'Label scan failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /food/recent — recently logged foods for quick re-add
// ═══════════════════════════════════════════════════════════════
router.get('/food/recent', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await logsCol(deviceId).orderBy('logged_at', 'desc').limit(60).get();

    const seen  = new Set();
    const items = [];
    snap.docs.forEach(d => {
      const data = d.data();
      const key  = (data.food_name || '').toLowerCase().trim();
      if (!seen.has(key) && key) {
        seen.add(key);
        items.push({
          id:           d.id,
          food_name:    data.food_name,
          name:         data.food_name,
          emoji:        data.emoji        || '🍽️',
          calories:     data.calories     || 0,
          protein:      data.protein      || 0,
          carbs:        data.carbs        || 0,
          fat:          data.fat          || 0,
          meal_type:    data.meal_type    || 'snack',
          serving_size: 100,
          serving_unit: 'g',
          source:       'recent',
        });
      }
    });

    res.json({ items: items.slice(0, 10) });
  } catch (err) {
    console.error('[nutrition] /food/recent error:', err);
    res.status(500).json({ error: 'Failed to get recent foods' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /food/search — text search
// ═══════════════════════════════════════════════════════════════
router.get('/food/search', async (req, res) => {
  try {
    const { q, deviceId } = req.query;
    if (!q || !deviceId) return res.status(400).json({ error: 'q and deviceId required' });

    const hasFatSecret = !!(process.env.FATSECRET_CLIENT_ID && process.env.FATSECRET_CLIENT_SECRET);

    const [fsResults, usdaResults, offResults] = await Promise.all([
      hasFatSecret ? searchFatSecret(q) : Promise.resolve([]),
      searchUSDA(q),
      searchOpenFoodFacts(q),
    ]);

    // FatSecret first (best search quality), then USDA whole foods, then OFF branded
    const ranked = rankSearchResults([...fsResults, ...usdaResults, ...offResults], q);

    // De-duplicate by normalised name prefix
    const seen   = new Set();
    const deduped = ranked.filter(item => {
      const key = (item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 22);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ results: deduped.slice(0, 10) });
  } catch (err) {
    console.error('[nutrition] /food/search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /food/barcode/:code
// ═══════════════════════════════════════════════════════════════
router.get('/food/barcode/:code', async (req, res) => {
  try {
    const { deviceId } = req.query;
    const { code }     = req.params;
    if (!deviceId || !code) return res.status(400).json({ error: 'deviceId and barcode required' });

    const result = await lookupBarcode(code);
    if (!result) return res.status(404).json({ error: 'Product not found' });
    res.json({ product: result });
  } catch (err) {
    console.error('[nutrition] /food/barcode error:', err);
    res.status(500).json({ error: 'Barcode lookup failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /cross-agent-trigger — receives signals from Mind agent
// ═══════════════════════════════════════════════════════════════
router.post('/cross-agent-trigger', async (req, res) => {
  try {
    const { deviceId, type, anxiety } = req.body;
    if (!deviceId || !type) return res.status(400).json({ error: 'deviceId and type required' });

    const today = dateStr();

    if (type === 'stress_spike' && anxiety >= 4) {
      const nutSnap = await nutDoc(deviceId).get();
      if (!nutSnap.exists || !nutSnap.data().setup_completed) return res.json({ skipped: true });
      const nutData = nutSnap.data();

      // Global daily gate — max 1 instant proactive per day across all pathways
      if (nutData.last_proactive_date !== today) {
        const msg = `Your stress levels just spiked (${anxiety}/5 logged in your Mind Coach). This is when cravings for high-fat, high-sugar foods are strongest — cortisol is doing its thing. Want me to help you plan your next meal before the craving hits? Or just log what you're feeling like eating right now and I'll work with it.`;
        await chatsCol(deviceId).add({
          role: 'assistant', content: msg, is_proactive: true,
          proactive_type: 'stress_eating_alert', is_read: false, date_str: today,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        await nutDoc(deviceId).update({ last_proactive_date: today });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[nutrition] /cross-agent-trigger error:', err);
    res.status(500).json({ error: 'Trigger failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /chat
// ═══════════════════════════════════════════════════════════════
router.post('/chat', async (req, res) => {
  try {
    const { deviceId, message, imageBase64, proactive_context } = req.body;
    if (!deviceId || (!message && !imageBase64)) return res.status(400).json({ error: 'deviceId and message or image required' });

    await chatsCol(deviceId).add({
      role: 'user', content: message, is_proactive: false,
      proactive_type: null, is_read: true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    let systemContext = await buildNutritionContext(deviceId);

    if (proactive_context) {
      systemContext += `\n\n[THREAD CONTEXT: User is replying to a proactive message about: ${proactive_context}. Continue that thread naturally.]`;
    }

    const historySnap = await chatsCol(deviceId)
      .orderBy('created_at', 'desc').limit(14).get();
    const history = historySnap.docs.reverse().map(d => ({
      role: d.data().role, content: d.data().content,
    }));

    // If user attached a photo, add vision analysis to message
    let userContent = message;
    let imageAnalysis = null;
    if (imageBase64) {
      try {
        imageAnalysis = await recognizeFood(imageBase64);
        const items = imageAnalysis.items || [];
        const analysisStr = items.map(i => `${i.name} (~${i.quantity}${i.unit})`).join(', ');
        const totalCals = items.reduce((s, i) => s + (i.calories || 0), 0);
        const totalProt = items.reduce((s, i) => s + (i.protein  || 0), 0);
        userContent = `${message || 'Analyze this food photo and tell me how it fits my macros today.'}\n[Photo: ${analysisStr || 'food item'}. Total: ~${totalCals} kcal, ~${Math.round(totalProt)}g protein]`;
      } catch { /* vision failed, continue with text only */ }
    }

    const messages = [{ role: 'system', content: systemContext }, ...history];
    if (imageBase64 && imageAnalysis) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: 'low' } },
          { type: 'text', text: userContent },
        ],
      });
    }

    const completion = await openai.chat.completions.create({
      model: imageBase64 ? MODELS.vision : MODELS.fast, temperature: 0.72, max_tokens: 1000,
      messages,
    });

    const reply = completion.choices[0].message.content.trim();

    const msgRef = await chatsCol(deviceId).add({
      role: 'assistant', content: reply, is_proactive: false,
      proactive_type: null, is_read: true,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, reply, message_id: msgRef.id, image_analysis: imageAnalysis });
  } catch (err) {
    console.error('[nutrition] /chat error:', err);
    res.status(500).json({ error: 'Chat failed' });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /chat/stream — SSE streaming (text-only; image upload uses POST /chat)
// ─────────────────────────────────────────────────────────────────
const { mountChatStream: _mountChatStreamNutrition } = require('./lib/chat-stream');
_mountChatStreamNutrition(router, {
  agentName: 'nutrition',
  openai, admin, chatsCol,
  model: MODELS.fast, maxTokens: 600, temperature: 0.72,
  buildPrompt: async (deviceId /* , message */) => {
    const systemPrompt = await buildNutritionContext(deviceId);
    const historySnap = await chatsCol(deviceId).orderBy('created_at', 'desc').limit(14).get();
    const history = historySnap.docs.reverse()
      .map(d => d.data())
      .filter(m => m.role === 'assistant' || m.role === 'user')
      .map(m => ({ role: m.role, content: m.content }));
    return { systemPrompt, history };
  },
});

// ═══════════════════════════════════════════════════════════════
// GET /chat
// ═══════════════════════════════════════════════════════════════
router.get('/chat', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId).orderBy('created_at', 'asc').limit(80).get();
    const messages = snap.docs.map(d => ({
      id: d.id, ...d.data(),
      created_at: d.data().created_at?.toDate?.()?.toISOString() || null,
    }));

    res.json({ messages });
  } catch (err) {
    console.error('[nutrition] GET /chat error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /chat/unread
// ═══════════════════════════════════════════════════════════════
router.get('/chat/unread', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId).where('is_read', '==', false).limit(20).get();
    const messages = snap.docs
      .map(d => ({ id: d.id, ...d.data(), created_at: toIsoString(d.data().created_at) }))
      .filter(m => m.is_proactive)
      .sort((a, b) => (a.created_at || '') > (b.created_at || '') ? -1 : 1)
      .slice(0, 5);

    res.json({ messages });
  } catch (err) {
    console.error('[nutrition] /chat/unread error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /chat/read
// ═══════════════════════════════════════════════════════════════
router.post('/chat/read', async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const snap = await chatsCol(deviceId).where('is_read', '==', false).get();
    if (snap.empty) return res.json({ success: true, marked: 0 });

    const batch = db().batch();
    snap.docs.forEach(d => batch.update(d.ref, { is_read: true }));
    await batch.commit();

    res.json({ success: true, marked: snap.size });
  } catch (err) {
    console.error('[nutrition] /chat/read error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /today — today's log + totals + targets + water (convenience alias)
// ═══════════════════════════════════════════════════════════════
router.get('/today', async (req, res) => {
  try {
    const { deviceId, date } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const targetDate = date || dateStr();
    const weekAgoStr = dateStr(new Date(Date.now() - 7 * 86400000));
    const [logsSnap, nutSnap, weekSnap] = await Promise.all([
      logsCol(deviceId).where('date_str', '==', targetDate).get(),
      nutDoc(deviceId).get(),
      logsCol(deviceId).where('date_str', '>=', weekAgoStr).get(),
    ]);

    const nutData = nutSnap.exists ? nutSnap.data() : {};
    const entries = logsSnap.docs.map(d => ({
      ...mapSnapDoc(d),
      logged_at: toIsoString(d.data().logged_at),
    })).sort((a, b) => (a.logged_at || '') > (b.logged_at || '') ? 1 : -1);

    const waterGlasses = nutData.water_today === targetDate ? (nutData.water_cups_today || 0) : 0;

    const totals = entries.reduce((acc, l) => ({
      calories: acc.calories + (l.calories || 0),
      protein:  acc.protein  + (l.protein  || 0),
      carbs:    acc.carbs    + (l.carbs    || 0),
      fat:      acc.fat      + (l.fat      || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    // Weekly summary
    const protTarget7d = nutData.protein_target || 140;
    const weekByDay = {};
    weekSnap.docs.forEach(d => {
      const data = d.data();
      const day  = data.date_str;
      if (!day) return;
      if (!weekByDay[day]) weekByDay[day] = { cals: 0, prot: 0 };
      weekByDay[day].cals += data.calories || 0;
      weekByDay[day].prot += data.protein  || 0;
    });
    const weekDays       = Object.keys(weekByDay).filter(d => d !== targetDate);
    const avgCals7d      = weekDays.length ? Math.round(weekDays.reduce((s, d) => s + weekByDay[d].cals, 0) / weekDays.length) : null;
    const protHitDays7d  = weekDays.filter(d => weekByDay[d].prot >= protTarget7d * 0.9).length;
    const daysLogged7d   = weekDays.length;

    res.json({
      entries,
      totals: {
        calories: Math.round(totals.calories),
        protein:  Math.round(totals.protein  * 10) / 10,
        carbs:    Math.round(totals.carbs    * 10) / 10,
        fat:      Math.round(totals.fat      * 10) / 10,
      },
      water_glasses: waterGlasses,
      targets: {
        calories: nutData.calorie_target      || 2000,
        protein:  nutData.protein_target      || 140,
        carbs:    nutData.carb_target         || 220,
        fat:      nutData.fat_target          || 65,
        water:    nutData.water_target_cups   || 8,
      },
      streak: nutData.streak || 0,
      weekly: { avg_cals: avgCals7d, protein_hit_days: protHitDays7d, days_logged: daysLogged7d },
    });
  } catch (err) {
    console.error('[nutrition] /today error:', err);
    res.status(500).json({ error: 'Failed to load today' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /actions — meal suggestions + habit + tips
// ═══════════════════════════════════════════════════════════════
router.get('/_legacy/actions', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [nutSnap, todaySnap] = await Promise.all([
      nutDoc(deviceId).get(),
      logsCol(deviceId).where('date_str', '==', dateStr()).get(),
    ]);

    if (!nutSnap.exists) return res.json({ meal_suggestions: [], habits: [], tips: [] });

    const nut = nutSnap.data();
    const todayLogs = todaySnap.docs.map(d => d.data());

    const eaten = todayLogs.reduce((acc, l) => ({
      calories: acc.calories + (l.calories || 0),
      protein:  acc.protein  + (l.protein  || 0),
      carbs:    acc.carbs    + (l.carbs    || 0),
      fat:      acc.fat      + (l.fat      || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

    const remaining = {
      calories: Math.max(0, (nut.calorie_target || 2000) - Math.round(eaten.calories)),
      protein:  Math.max(0, (nut.protein_target || 140)  - Math.round(eaten.protein)),
      carbs:    Math.max(0, (nut.carb_target    || 220)  - Math.round(eaten.carbs)),
      fat:      Math.max(0, (nut.fat_target     || 65)   - Math.round(eaten.fat)),
    };

    const goal      = nut.goal || 'eat_healthier';
    const style     = Array.isArray(nut.dietary_style) ? nut.dietary_style.join(', ') : (nut.dietary_style || 'omnivore');
    const challenge = Array.isArray(nut.biggest_challenge) ? nut.biggest_challenge.join(', ') : (nut.biggest_challenge || 'knowledge');
    const allergies = (nut.allergies || []).filter(a => a !== 'None').join(', ') || 'none';

    // Daily cache — avoid regenerating on every tab open
    const today = dateStr();
    const ac    = nut.actions_cache;
    if (ac && ac.date === today && Math.abs((ac.remaining_cals || 0) - remaining.calories) < 150 && ac.meal_suggestions?.length) {
      return res.json({ remaining, meal_suggestions: ac.meal_suggestions, habits: ac.habits || [], tips: ac.tips || [] });
    }

    const prompt = `You are a nutrition coach. Generate personalized actions for this user's remaining macros today.

User's remaining macros for today:
- Calories: ${remaining.calories} kcal
- Protein: ${remaining.protein}g
- Carbs: ${remaining.carbs}g
- Fat: ${remaining.fat}g

User profile:
- Goal: ${goal}
- Dietary style: ${style}
- Biggest challenge: ${challenge}
- Allergies/restrictions: ${allergies}

Return ONLY valid JSON with exactly this structure:
{
  "meal_suggestions": [
    {
      "name": "Grilled Chicken & Rice Bowl",
      "calories": 520,
      "protein": 45,
      "carbs": 52,
      "fat": 12,
      "reason": "Hits your remaining protein target almost exactly and keeps you on track for the day."
    }
  ],
  "habits": [
    {
      "icon": "💪",
      "title": "Protein at every meal",
      "body": "Aim for at least 30g protein at breakfast, lunch, and dinner to hit your daily target without stress.",
      "tip": "Greek yogurt, eggs, cottage cheese, or chicken are all quick wins."
    }
  ],
  "tips": [
    {
      "icon": "💡",
      "title": "Front-load your protein",
      "body": "Eating most of your protein earlier in the day makes hitting the target 60% easier than leaving it all to dinner."
    }
  ]
}

Rules:
- 3 meal suggestions exactly, realistic, matching dietary style and allergies
- Each suggestion should fit the remaining macro budget approximately
- 1 habit focused on biggest_challenge
- 2 tips specific to the goal
- Be specific and actionable, not generic`;

    let parsed = { meal_suggestions: [], habits: [], tips: [] };
    try {
      const completion = await openai.chat.completions.create({
        model: MODELS.fast, temperature: 0.6, max_tokens: 700,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      });
      parsed = safeJSON(completion.choices[0].message.content) || { meal_suggestions: [], habits: [], tips: [] };
      // Save daily cache
      await nutDoc(deviceId).update({
        actions_cache: {
          date: today,
          remaining_cals: remaining.calories,
          meal_suggestions: parsed.meal_suggestions || [],
          habits: parsed.habits || [],
          tips: parsed.tips || [],
        },
      });
    } catch { /* return empty if AI fails */ }

    res.json({
      remaining,
      meal_suggestions: parsed.meal_suggestions || [],
      habits:           parsed.habits           || [],
      tips:             parsed.tips             || [],
    });
  } catch (err) {
    console.error('[nutrition] /actions error:', err);
    res.status(500).json({ error: 'Actions failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /logs/calendar — marked dates for calendar dots
// ═══════════════════════════════════════════════════════════════
router.get('/logs/calendar', async (req, res) => {
  try {
    const { deviceId, month } = req.query; // month = 'YYYY-MM'
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const prefix = month || dateStr().slice(0, 7);
    const start  = `${prefix}-01`;
    const end    = `${prefix}-31`;
    const snap = await logsCol(deviceId)
      .where('date_str', '>=', start)
      .where('date_str', '<=', end)
      .get();
    const marked = {};
    snap.docs.forEach(d => { const ds = d.data().date_str; if (ds) marked[ds] = true; });
    // Also include last 60 days for the strip
    const snap60 = await logsCol(deviceId)
      .where('date_str', '>=', dateStr(new Date(Date.now() - 60 * 86400000)))
      .get();
    snap60.docs.forEach(d => { const ds = d.data().date_str; if (ds) marked[ds] = true; });
    res.json({ marked });
  } catch (err) {
    console.error('[nutrition] /logs/calendar error:', err);
    res.status(500).json({ error: 'Calendar fetch failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /food/parse-text — natural language food parsing (GPT-4o)
// ═══════════════════════════════════════════════════════════════
router.post('/food/parse-text', async (req, res) => {
  try {
    const { deviceId, text } = req.body;
    if (!deviceId || !text) return res.status(400).json({ error: 'deviceId and text required' });

    const prompt = `You are a nutrition AI. Parse this natural language food description and return all food items with estimated macros.

Input: "${text}"

For EACH food item identified, estimate:
- name: simple food name in English
- quantity: estimated amount as number
- unit: g | ml | piece | cup | tbsp | oz | slice | serving
- emoji: single most relevant food emoji
- confidence: "high" | "medium" | "low"
- calories: estimated kcal for THIS specific quantity
- protein: estimated grams of protein
- carbs: estimated grams of carbohydrates
- fat: estimated grams of fat

Be realistic. Use standard portion sizes when not specified.

Return ONLY valid JSON:
{
  "items": [
    { "name": "scrambled eggs", "quantity": 2, "unit": "large", "emoji": "🥚", "confidence": "high", "calories": 182, "protein": 12, "carbs": 2, "fat": 14 }
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: MODELS.fast, temperature: 0.3, max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = safeJSON(completion.choices[0].message.content, { items: [] });
    res.json({ items: parsed.items || [] });
  } catch (err) {
    console.error('[nutrition] /food/parse-text error:', err);
    res.status(500).json({ error: 'Text parsing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DESCRIBE PIPELINE — Whisper + GPT-4o structured output
// POST /describe         — audio OR text → parsed items (NOT logged)
// POST /describe/confirm — log the user-confirmed items
// ═══════════════════════════════════════════════════════════════

// Strict JSON schema for GPT-4o structured outputs
const DESCRIBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meal_name', 'items'],
  properties: {
    meal_name: { type: 'string', description: 'Short descriptive name for the whole meal (e.g., "Chicken Caesar Salad", "Greek Yogurt Bowl")' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'emoji', 'quantity', 'unit', 'calories', 'protein', 'carbs', 'fat', 'confidence'],
        properties: {
          name:        { type: 'string', description: 'Specific food item name in English' },
          emoji:       { type: 'string', description: 'Single most relevant food emoji' },
          quantity:    { type: 'number', description: 'Numeric portion (use grams when possible)' },
          unit:        { type: 'string', enum: ['g', 'ml', 'piece', 'pieces', 'cup', 'tbsp', 'tsp', 'oz', 'slice', 'slices', 'serving', 'servings'] },
          calories:    { type: 'number', description: 'Total kcal for THIS quantity (whole number)' },
          protein:     { type: 'number', description: 'Grams of protein, 1 decimal' },
          carbs:       { type: 'number', description: 'Grams of carbs, 1 decimal' },
          fat:         { type: 'number', description: 'Grams of fat, 1 decimal' },
          confidence:  { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

function _buildDescribeSystemPrompt(setup = {}) {
  const diet     = setup.dietary_style || 'no_restrictions';
  const allergies= Array.isArray(setup.allergies) ? setup.allergies.join(', ') : 'none';
  const goal     = setup.goal || 'maintain';

  return `You are an elite nutritionist parsing natural-language food descriptions into precise structured nutrition data. Accuracy matters — users trust your numbers.

USER CONTEXT:
- Goal: ${goal}
- Dietary style: ${diet}
- Allergies/avoids: ${allergies}

CORE RULES:
1. STRIP NARRATIVE: ignore "I had", "I ate", "for breakfast", "today", "this morning", "with my friend", etc. These are NOT food.
2. Identify EVERY distinct food/drink item. "chicken caesar salad" is 4 items: chicken, romaine, parmesan, dressing — not one merged item. "Eggs and toast" is 2 items.
3. CONNECTOR WORDS = SEPARATE ITEMS: "with", "and", "&", "plus", "+", commas → always split.
   - "toast with butter" → toast + butter
   - "coffee with milk and sugar" → coffee + milk + sugar
   - "chicken and rice" → chicken + rice
4. Use grams (g) / milliliters (ml) by default. 'piece' / 'slice' / 'cup' only when clearly indicated.
5. Default to STANDARD ADULT PORTIONS when quantity is unspecified:
   - chicken breast → 150g | scrambled eggs → 2 large (100g) | fried egg → 1 large (50g)
   - white rice cooked → 1 cup (158g) | brown rice cooked → 1 cup (195g)
   - pasta cooked → 1 cup (140g) | salad greens → 80g
   - pizza slice → 107g | bread slice → 30g | toast slice → 30g
   - coffee → 240ml | tea → 240ml | smoothie → 480ml
   - latte (no size) → tall = 354ml | soda (no size) → 1 can = 355ml
   - beer → 355ml | wine → 150ml | water → 0 kcal
   - fish/salmon/cod (no weight) → 150g | tuna can → 85g
   - banana medium → 118g | apple medium → 182g
6. BRANDED DRINKS — common ones to recognize without ambiguity:
   - "Coca-Cola" / "Coke" → 1 can (355ml) = 140 kcal C39 | "Diet Coke" → 0 kcal
   - "Pepsi" → 355ml = 150 kcal | "Sprite" → 355ml = 140 kcal
   - "Red Bull" → 250ml = 110 kcal | "Monster" → 473ml = 210 kcal
   - "Gatorade" → 591ml = 140 kcal
7. INDIAN/REGIONAL FOODS — common defaults:
   - roti/chapati (1 medium 40g) → 120 kcal P3 C20 F3
   - paratha (1 medium 80g) → 260 kcal P5 C32 F12
   - dal (1 cup) → 230 kcal P18 C40 F1
   - gulab jamun (1 piece 30g) → 140 kcal P2 C20 F6
   - samosa (1 piece) → 260 kcal P4 C25 F16
   - idli (1) → 39 kcal P2 C8 F0 | dosa plain → 170 kcal
   - paneer (100g) → 265 kcal P18 C1 F21
   - biryani veg (1 cup) → 280 kcal | chicken biryani (1 cup) → 350 kcal
8. Brand recognition (Starbucks, Chipotle, McDonald's, Subway, Sweetgreen, etc.) → use brand published values.
9. Caloric math sanity: protein × 4 + carbs × 4 + fat × 9 must be within 10% of calories. Audit before returning.
10. Confidence rubric:
    - "high": specific weight, brand, or unambiguous food
    - "medium": common food, default portion used
    - "low": vague/composite (e.g. "leftovers", "snack", "drink")
11. NEVER invent precision: protein 1 decimal, calories whole numbers, never zero unless truly zero (water).
12. Honor dietary style: vegetarian → no meat unless explicit; vegan → no animal products unless explicit.
13. Meal name: 2–5 words, Title Case (e.g. "Eggs & Toast", "Chicken Rice Bowl").
14. Pick the most relevant food emoji (🍳🥚🍞🍚🍗🥗☕🥤🥖🍌🍎🥛🧀🥩🐟🍣🍕🌮🍜🍝).

EXAMPLES:

Input: "two scrambled eggs and a slice of toast with butter for breakfast"
Output:
{
  "meal_name": "Eggs & Toast",
  "items": [
    { "name": "Scrambled eggs", "emoji": "🍳", "quantity": 2, "unit": "pieces", "calories": 182, "protein": 12.6, "carbs": 1.4, "fat": 13.8, "confidence": "high" },
    { "name": "Toast (white bread)", "emoji": "🍞", "quantity": 1, "unit": "slice", "calories": 75, "protein": 2.6, "carbs": 14.0, "fat": 1.0, "confidence": "high" },
    { "name": "Butter", "emoji": "🧈", "quantity": 7, "unit": "g", "calories": 50, "protein": 0.1, "carbs": 0, "fat": 5.7, "confidence": "medium" }
  ]
}

Input: "chicken caesar salad for lunch"
Output:
{
  "meal_name": "Chicken Caesar Salad",
  "items": [
    { "name": "Grilled chicken breast", "emoji": "🍗", "quantity": 150, "unit": "g", "calories": 248, "protein": 46.5, "carbs": 0, "fat": 5.4, "confidence": "high" },
    { "name": "Romaine lettuce", "emoji": "🥬", "quantity": 80, "unit": "g", "calories": 14, "protein": 1.0, "carbs": 2.6, "fat": 0.2, "confidence": "high" },
    { "name": "Parmesan cheese", "emoji": "🧀", "quantity": 20, "unit": "g", "calories": 79, "protein": 7.1, "carbs": 0.7, "fat": 5.3, "confidence": "high" },
    { "name": "Caesar dressing", "emoji": "🥗", "quantity": 30, "unit": "g", "calories": 158, "protein": 0.9, "carbs": 1.1, "fat": 16.7, "confidence": "high" },
    { "name": "Croutons", "emoji": "🥖", "quantity": 15, "unit": "g", "calories": 62, "protein": 1.6, "carbs": 11.5, "fat": 1.0, "confidence": "medium" }
  ]
}

Input: "tall starbucks latte with oat milk"
Output:
{
  "meal_name": "Starbucks Oat Milk Latte",
  "items": [
    { "name": "Starbucks Tall Latte (oat milk)", "emoji": "☕", "quantity": 354, "unit": "ml", "calories": 180, "protein": 6.0, "carbs": 23.0, "fat": 7.0, "confidence": "high" }
  ]
}`;
}

// ─── Brand grounding DB — top chains where AI hallucinates portions ──
const _BRAND_DB = {
  chipotle: 'Chipotle bowl/burrito ≈ 700–1000 kcal. Default bowl: white rice 185g (242 kcal) + black beans 130g (170 kcal) + chicken 113g (180 kcal P32) + salsa + cheese 28g (110 kcal) + lettuce. Tortilla adds 320 kcal.',
  starbucks: 'Starbucks Tall=354ml, Grande=473ml, Venti=591ml. Latte (Grande, whole milk)≈190 kcal P12 C18 F8. Oat milk latte (Grande)≈200 kcal P5 C30 F7. Caramel macchiato (Grande)≈250 kcal.',
  mcdonalds: 'Big Mac 540 kcal P25 C46 F28. Quarter Pounder 520 kcal. McChicken 400 kcal. 10pc Nuggets 410 kcal. Medium fries 320 kcal P5 C43 F15. Egg McMuffin 310 kcal P17 C30 F13.',
  sweetgreen: 'Sweetgreen bowl ≈ 500–650 kcal. Harvest bowl 705 kcal P17. Kale Caesar 570 kcal. Add-ins: chicken +210 kcal P32, salmon +330 kcal.',
  cava: 'CAVA bowl ≈ 600–900 kcal. Greens+grains base + protein (chicken 280 kcal, lamb 350 kcal) + dips (hummus 70, tzatziki 50) + toppings.',
  subway: 'Subway 6-inch Italian BMT ≈ 410 kcal. Turkey breast 6-inch 280 kcal P18. Tuna 6-inch 480 kcal. Footlongs are 2× values.',
  'chick-fil-a': 'Chicken Sandwich 440 kcal P28 C41 F19. Spicy Sandwich 450 kcal. 8pc Nuggets 250 kcal P27. Waffle Fries (medium) 420 kcal.',
  panera: 'Panera bowls 500–800 kcal. Mediterranean 600 kcal. Soup cup 240–340 kcal. Half sandwich 250–400 kcal.',
  'taco bell': 'Crunchy taco 170 kcal. Soft taco 180 kcal. Crunchwrap Supreme 530 kcal P16. Burrito Supreme 390 kcal.',
  kfc: 'Original Recipe drumstick 130 kcal P10 F8. Breast 320 kcal P39. Mashed potatoes (small) 110 kcal. Biscuit 180 kcal.',
  dominos: 'Domino\'s pizza per slice (large hand-tossed cheese) ≈ 290 kcal P12 C36 F11. Pepperoni slice 320 kcal.',
  'pizza hut': 'Pizza Hut large pan cheese slice ≈ 300 kcal. Pepperoni 340 kcal. Personal pan pizza 590 kcal whole.',
  shake_shack: 'ShackBurger 480 kcal P26 F29. Cheese fries 470 kcal. Vanilla shake 700 kcal.',
  'in-n-out': 'Double-Double 670 kcal P37 F41. Cheeseburger 480 kcal. Fries (regular) 395 kcal.',
  dunkin: 'Dunkin medium iced coffee w/ cream+sugar ≈ 130 kcal. Glazed donut 240 kcal. Bacon Egg Cheese sandwich 520 kcal.',
};
const _BRAND_REGEX = new RegExp(
  '\\b(' + Object.keys(_BRAND_DB).map(k => k.replace(/[-]/g, '[- ]?')).join('|') + ')\\b',
  'gi'
);
function _detectBrands(text = '') {
  const hits = new Set();
  const matches = (text || '').toLowerCase().matchAll(_BRAND_REGEX);
  for (const m of matches) {
    const norm = m[0].toLowerCase().replace(/[- ]/g, key => key);
    const key = Object.keys(_BRAND_DB).find(k => norm.includes(k.replace(/[- ]/g, '')) || k.replace(/[- ]/g, '').includes(norm.replace(/[- ]/g, '')));
    if (key) hits.add(key);
  }
  return Array.from(hits);
}

// Vague terms that need clarification chips downstream
const _VAGUE_TERMS = new Set([
  'snack','snacks','something','food','stuff','things','meal','lunch','dinner','breakfast',
  'drink','beverage','dessert','leftovers','a bite','bites','some food',
]);
function _detectVague(items = []) {
  const flagged = [];
  for (const it of items) {
    const key = (it.name || '').toLowerCase().trim();
    if (_VAGUE_TERMS.has(key) || it.confidence === 'low') {
      flagged.push({
        item_name:  it.name,
        item_emoji: it.emoji || '🍽️',
        question:   `What kind of ${it.name?.toLowerCase()}? Be specific for accuracy.`,
      });
    }
  }
  return flagged;
}

// Macro-math sanity: kcal should ≈ P*4 + C*4 + F*9 within 15%.
// Returns { ok, drift_pct, item_drifts[] } so we can decide on a retry.
function _checkMacroSanity(items = []) {
  const drifts = [];
  let totalDrift = 0;
  for (const it of items) {
    const expected = (it.protein || 0) * 4 + (it.carbs || 0) * 4 + (it.fat || 0) * 9;
    const cal = it.calories || 0;
    if (cal < 5) continue;
    const drift = Math.abs(cal - expected) / cal;
    drifts.push({ name: it.name, drift_pct: Math.round(drift * 100) });
    totalDrift = Math.max(totalDrift, drift);
  }
  return { ok: totalDrift < 0.15, drift_pct: Math.round(totalDrift * 100), item_drifts: drifts };
}

// Concurrency lock — at most one /describe job in-flight per deviceId
const _describeLocks = new Map();
function _acquireLock(deviceId) {
  if (_describeLocks.has(deviceId)) return false;
  _describeLocks.set(deviceId, Date.now());
  return true;
}
function _releaseLock(deviceId) {
  _describeLocks.delete(deviceId);
}
// Auto-release stale locks (>30s)
setInterval(() => {
  const now = Date.now();
  for (const [k, t] of _describeLocks.entries()) {
    if (now - t > 30_000) _describeLocks.delete(k);
  }
}, 10_000).unref?.();

async function _runDescribePipeline({ deviceId, transcript, onProgress = null }) {
  const emit = (stage, message, extra = {}) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, message, ...extra }); } catch {}
    }
  };

  emit('reading', 'Reading your meal…');

  // Load user setup for personalized prompt
  const nutSnap = await nutDoc(deviceId).get();
  const setup   = nutSnap.exists ? (nutSnap.data() || {}) : {};

  // Brand pre-flight (free regex, no extra LLM cost)
  const brandHits = _detectBrands(transcript);
  let brandGrounding = '';
  if (brandHits.length) {
    brandGrounding = '\n\nBrand context: ' +
      brandHits.map(b => _BRAND_DB[b].split('.')[0]).join(' | ');
  }

  emit('calculating', 'Calculating macros…');

  const systemPrompt = _buildDescribeSystemPrompt(setup) + brandGrounding;

  // Single LLM call — no sanity-retry loop (was doubling latency).
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: MODELS.fast,
      max_completion_tokens: 450,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Parse: "${transcript}"` },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'meal_parse', strict: true, schema: DESCRIBE_SCHEMA },
      },
    });
  } catch (err) {
    console.error('[describe] LLM call failed:', err?.message);
    throw err;
  }
  const parsed = safeJSON(completion.choices[0].message.content, { meal_name: '', items: [] });
  const sanity = _checkMacroSanity(parsed.items || []);

  // Enrich each item with food_quality_score (deterministic)
  const items = (parsed.items || []).map((it, idx) => ({
    ...it,
    _id: `tmp_${Date.now()}_${idx}`,
    food_quality_score: _computeFoodQuality({
      calories: it.calories || 0,
      protein:  it.protein  || 0,
      carbs:    it.carbs    || 0,
      fat:      it.fat      || 0,
      food_name: it.name    || '',
    }),
  }));

  // Aggregate totals + average quality
  const total = items.reduce((acc, it) => ({
    calories: acc.calories + (it.calories || 0),
    protein:  acc.protein  + (it.protein  || 0),
    carbs:    acc.carbs    + (it.carbs    || 0),
    fat:      acc.fat      + (it.fat      || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  const food_quality_avg = items.length
    ? Math.round(items.reduce((s, it) => s + (it.food_quality_score || 0), 0) / items.length)
    : null;

  // Aggregate confidence — lowest wins (worst-case)
  const confOrder = { low: 0, medium: 1, high: 2 };
  const overallConfidence = items.reduce(
    (lowest, it) => confOrder[it.confidence] < confOrder[lowest] ? it.confidence : lowest,
    'high'
  );

  // Allergen check against user setup
  const userAllergies = Array.isArray(setup.allergies) ? setup.allergies.map(a => String(a).toLowerCase()) : [];
  const allergenHits = [];
  if (userAllergies.length) {
    for (const it of items) {
      const name = (it.name || '').toLowerCase();
      for (const a of userAllergies) {
        if (a !== 'none' && name.includes(a)) {
          allergenHits.push({ item_name: it.name, allergen: a });
        }
      }
    }
  }

  emit('finalizing', 'Almost there…', { item_count: items.length });

  return {
    meal_name:        parsed.meal_name || 'Meal',
    transcript,
    items,
    total: {
      calories: Math.round(total.calories),
      protein:  Math.round(total.protein * 10) / 10,
      carbs:    Math.round(total.carbs   * 10) / 10,
      fat:      Math.round(total.fat     * 10) / 10,
    },
    food_quality_avg,
    confidence:      overallConfidence,
    brand_hits:      brandHits,
    clarifications:  _detectVague(items),
    allergen_hits:   allergenHits,
    sanity_drift_pct: sanity.drift_pct,
  };
}

// POST /describe — audio (base64 wav/m4a) OR transcript → parsed meal
// ═══════════════════════════════════════════════════════════════
// GET /describe/dg-token — mints a short-lived Deepgram token so
// the mobile client can connect directly to Deepgram WebSocket
// without exposing the master API key. Returns 503 if not configured;
// frontend gracefully falls back to iOS Voice.
// ═══════════════════════════════════════════════════════════════
router.get('/describe/dg-token', async (req, res) => {
  const t0 = Date.now();
  const key = process.env.DEEPGRAM_API_KEY;
  console.log('[⏱ DEEPGRAM] /dg-token requested. Key configured:', !!key);
  if (!key) {
    console.log('[⏱ DEEPGRAM] ❌ DEEPGRAM_API_KEY not set in .env — returning 503');
    return res.status(503).json({ error: 'deepgram_not_configured' });
  }
  try {
    const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    const elapsed = Date.now() - t0;
    if (!r.ok) {
      const txt = await r.text();
      console.error(`[⏱ DEEPGRAM] ❌ token grant FAILED (${elapsed}ms): ${r.status} ${txt}`);
      return res.status(502).json({ error: 'deepgram_grant_failed', detail: txt });
    }
    const data = await r.json();
    console.log(`[⏱ DEEPGRAM] ✅ token minted in ${elapsed}ms. TTL=${data.expires_in}s`);
    res.json({
      access_token: data.access_token,
      expires_in:   data.expires_in || 60,
    });
  } catch (err) {
    console.error('[⏱ DEEPGRAM] dg-token exception:', err);
    res.status(500).json({ error: 'dg_token_failed' });
  }
});

// ─── /describe/dg-test — proves Deepgram is reachable + measures latency ──
// Curl from terminal:  curl http://localhost:5001/api/nutrition/describe/dg-test
router.get('/describe/dg-test', async (req, res) => {
  const t0 = Date.now();
  const key = process.env.DEEPGRAM_API_KEY;
  console.log('[⏱ DEEPGRAM-TEST] Running connectivity test…');
  if (!key) {
    return res.status(503).json({
      ok: false,
      error: 'DEEPGRAM_API_KEY not in .env',
      hint: 'Add DEEPGRAM_API_KEY=<your_key> to stillalive-backend/.env and restart server',
    });
  }
  try {
    // Test 1: token grant latency (auth roundtrip)
    const tokenT0 = Date.now();
    const tokenR = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    const tokenMs = Date.now() - tokenT0;
    if (!tokenR.ok) {
      const txt = await tokenR.text();
      return res.status(502).json({
        ok: false,
        error: `Token grant failed: ${tokenR.status}`,
        detail: txt,
        elapsed_ms: Date.now() - t0,
      });
    }
    const tokenData = await tokenR.json();

    // Test 2: transcribe a tiny test audio URL to prove the service responds
    const testAudioUrl = 'https://static.deepgram.com/examples/Bueller-Life-moves-pretty-fast.wav';
    const transT0 = Date.now();
    const transR = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true',
      {
        method: 'POST',
        headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: testAudioUrl }),
      }
    );
    const transMs = Date.now() - transT0;
    if (!transR.ok) {
      const txt = await transR.text();
      return res.status(502).json({
        ok: false,
        error: `Transcription failed: ${transR.status}`,
        detail: txt,
        token_grant_ms: tokenMs,
        elapsed_ms: Date.now() - t0,
      });
    }
    const transData = await transR.json();
    const transcript = transData.results?.channels?.[0]?.alternatives?.[0]?.transcript || '(none)';
    const totalMs = Date.now() - t0;

    console.log(`[⏱ DEEPGRAM-TEST] ✅ token=${tokenMs}ms, transcribe=${transMs}ms, total=${totalMs}ms`);
    console.log(`[⏱ DEEPGRAM-TEST] Sample audio transcribed: "${transcript}"`);

    res.json({
      ok: true,
      message: 'Deepgram is configured and reachable',
      timings_ms: {
        token_grant: tokenMs,
        sample_transcription: transMs,
        total: totalMs,
      },
      sample_audio_url: testAudioUrl,
      sample_transcription: transcript,
      tts_token_expires_in: tokenData.expires_in,
      next_step: 'Frontend can now connect to Deepgram WebSocket using a fresh token.',
    });
  } catch (err) {
    console.error('[⏱ DEEPGRAM-TEST] exception:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ─── /describe/transcribe — audio → clean transcript only ──
// Used as Layer 2 of the voice flow: Apple recognizer gives a rough live
// preview, then we upload the WAV to OpenAI's gpt-4o-transcribe (4.1% WER)
// for an accurate final transcript. NO food parsing here — that's Layer 3.
router.post('/describe/transcribe', async (req, res) => {
  const t0 = Date.now();
  try {
    const { audio_base64, audio_mime } = req.body;
    if (!audio_base64) return res.status(400).json({ error: 'audio_base64 required' });

    const buffer = Buffer.from(audio_base64, 'base64');
    const ext = (audio_mime || 'audio/wav').split('/').pop().replace('mpeg', 'mp3');
    const file = await OpenAI.toFile(buffer, `audio.${ext}`);
    const result = await openai.audio.transcriptions.create({
      file,
      model:    'gpt-4o-transcribe',  // 4.1% WER, 22% better than whisper-1, same price
      language: 'en',
      response_format: 'json',
    });
    const transcript = (result.text || '').trim();
    if (!transcript) return res.status(400).json({ error: 'No speech detected' });

    res.json({
      transcript,
      latency_ms: Date.now() - t0,
      model: 'gpt-4o-transcribe',
    });
  } catch (err) {
    console.error('[nutrition] /describe/transcribe error:', err);
    res.status(500).json({ error: err.message || 'Transcription failed' });
  }
});

router.post('/describe', async (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  if (!_acquireLock(deviceId)) {
    return res.status(429).json({ error: 'analyze_in_progress', message: 'Already analyzing — please wait.' });
  }
  try {
    const { audio_base64, audio_mime, transcript: providedTranscript } = req.body;
    if (!audio_base64 && !providedTranscript) {
      return res.status(400).json({ error: 'audio_base64 or transcript required' });
    }

    // ── Step 1: Get transcript ──
    let transcript = (providedTranscript || '').trim();
    if (!transcript && audio_base64) {
      const buffer = Buffer.from(audio_base64, 'base64');
      const ext    = (audio_mime || 'audio/wav').split('/').pop().replace('mpeg', 'mp3');
      const file   = await OpenAI.toFile(buffer, `audio.${ext}`);
      const result = await openai.audio.transcriptions.create({
        file,
        model: 'gpt-4o-transcribe',
        language: 'en',
        response_format: 'json',
      });
      transcript = (result.text || '').trim();
    }

    if (!transcript) {
      return res.status(400).json({ error: 'Could not understand audio. Please try again.' });
    }

    const result = await _runDescribePipeline({ deviceId, transcript });
    const hr = new Date().getHours();
    const meal_type = hr < 11 ? 'breakfast' : hr < 15 ? 'lunch' : hr < 21 ? 'dinner' : 'snack';

    res.json({ ...result, meal_type });
  } catch (err) {
    console.error('[nutrition] /describe error:', err);
    res.status(500).json({ error: err.message || 'Describe failed' });
  } finally {
    _releaseLock(deviceId);
  }
});

// ─── /describe/preflight — instant inspection (no LLM) ──
// Lets the FE adjust UI before paying for an analyze call.
router.post('/describe/preflight', (req, res) => {
  try {
    const { text } = req.body || {};
    const t = (text || '').trim();
    const word_count = t ? t.split(/\s+/).length : 0;
    const brand_hits = _detectBrands(t);
    const lc = t.toLowerCase();
    const has_vague = Array.from(_VAGUE_TERMS).some(v => new RegExp(`\\b${v}\\b`).test(lc));
    // Rough item estimate from "and"/comma separators
    const est_items = Math.max(1, t.split(/(,| and | with | & |\\+)/i).filter(s => s && s.trim().length > 2).length / 2 | 0);
    res.json({
      word_count,
      has_brand: brand_hits.length > 0,
      brand_hits,
      has_vague,
      est_items: Math.min(est_items, 8),
      ready_to_analyze: word_count >= 2,
    });
  } catch (err) {
    res.status(500).json({ error: 'preflight_failed' });
  }
});

// ─── /describe/stream — SSE: real progress events from the pipeline ──
// Frontend opens an EventSource (or fetch+streaming reader) and gets:
//   event: stage   data: {"stage":"reading","message":"..."}
//   event: result  data: <full result>
//   event: error   data: {"error":"..."}
router.post('/describe/stream', async (req, res) => {
  const { deviceId, transcript } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const t = (transcript || '').trim();
  if (!t) return res.status(400).json({ error: 'transcript required' });

  if (!_acquireLock(deviceId)) {
    return res.status(429).json({ error: 'analyze_in_progress' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, payload) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  };
  // Heartbeat every 10s in case of intermediary buffering
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 10_000);

  try {
    const result = await _runDescribePipeline({
      deviceId,
      transcript: t,
      onProgress: (e) => send('stage', e),
    });
    const hr = new Date().getHours();
    const meal_type = hr < 11 ? 'breakfast' : hr < 15 ? 'lunch' : hr < 21 ? 'dinner' : 'snack';
    send('result', { ...result, meal_type });
  } catch (err) {
    console.error('[nutrition] /describe/stream error:', err);
    send('error', { error: err.message || 'Describe failed' });
  } finally {
    clearInterval(hb);
    _releaseLock(deviceId);
    try { res.end(); } catch {}
  }
});

// ─── /describe/feedback — telemetry to improve prompts over time ──
// FE sends: { deviceId, jobId, items_kept, items_edited, items_deleted, transcript_edited, brand_hits, sanity_drift_pct }
router.post('/describe/feedback', async (req, res) => {
  try {
    const { deviceId, ...payload } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await nutDoc(deviceId).collection('describe_feedback').add({
      ...payload,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[nutrition] /describe/feedback error:', err);
    res.status(500).json({ error: 'feedback_failed' });
  }
});

// POST /describe/confirm — log all confirmed items in one shot
router.post('/describe/confirm', async (req, res) => {
  try {
    const { deviceId, items, meal_type, meal_name, date_str: logDate } = req.body;
    if (!deviceId || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'deviceId and items required' });
    }
    const today = logDate || dateStr();
    const mealType = meal_type || 'snack';

    // Write all items in parallel
    const writes = await Promise.all(items.map(it => {
      const cal = Math.round(it.calories || 0);
      const p   = Math.round((it.protein || 0) * 10) / 10;
      const c   = Math.round((it.carbs   || 0) * 10) / 10;
      const f   = Math.round((it.fat     || 0) * 10) / 10;
      const fq  = it.food_quality_score != null
        ? it.food_quality_score
        : _computeFoodQuality({ calories: cal, protein: p, carbs: c, fat: f, food_name: it.name || '' });
      return logsCol(deviceId).add({
        food_name: it.name || 'Food',
        emoji:     it.emoji || '🍽️',
        meal_type: mealType,
        calories:  cal,
        protein:   p,
        carbs:     c,
        fat:       f,
        quantity:  it.quantity || 1,
        unit:      it.unit || 'serving',
        food_id:   null,
        source:    'describe',
        date_str:  today,
        food_quality_score: fq,
        meal_name: meal_name || null,
        logged_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    }));

    // Update streak (single update for the meal, not per-item)
    const nutSnap = await nutDoc(deviceId).get();
    const nutData = nutSnap.data() || {};
    const lastLog = nutData.last_log_date;
    const yesterday = dateStr(new Date(Date.now() - 86400000));
    const newStreak = (lastLog === yesterday || lastLog === today)
      ? (lastLog === today ? (nutData.streak || 1) : (nutData.streak || 0) + 1)
      : 1;
    await nutDoc(deviceId).set({ last_log_date: today, streak: newStreak }, { merge: true });

    _onNutritionLog(deviceId);
    refreshNutritionScore(deviceId).catch(() => {});

    res.json({
      success: true,
      logged_count: writes.length,
      ids: writes.map(w => w.id),
      streak: newStreak,
    });
  } catch (err) {
    console.error('[nutrition] /describe/confirm error:', err);
    res.status(500).json({ error: 'Confirm failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /templates — save a meal template
// ═══════════════════════════════════════════════════════════════
router.post('/templates', async (req, res) => {
  try {
    const { deviceId, name, emoji, items } = req.body;
    if (!deviceId || !name || !items?.length) return res.status(400).json({ error: 'deviceId, name, items required' });
    const totals = items.reduce((acc, i) => ({
      calories: acc.calories + (i.calories || 0),
      protein:  acc.protein  + (i.protein  || 0),
      carbs:    acc.carbs    + (i.carbs    || 0),
      fat:      acc.fat      + (i.fat      || 0),
    }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
    const ref = await nutDoc(deviceId).collection('templates').add({
      name, emoji: emoji || '🍽️', items,
      total_calories: Math.round(totals.calories),
      total_protein:  Math.round(totals.protein * 10) / 10,
      total_carbs:    Math.round(totals.carbs   * 10) / 10,
      total_fat:      Math.round(totals.fat     * 10) / 10,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, id: ref.id });
  } catch (err) {
    console.error('[nutrition] POST /templates error:', err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /templates — list saved templates
// ═══════════════════════════════════════════════════════════════
router.get('/templates', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const snap = await nutDoc(deviceId).collection('templates').orderBy('created_at', 'desc').limit(20).get();
    const templates = snap.docs.map(d => ({ id: d.id, ...d.data(), created_at: d.data().created_at?.toDate?.()?.toISOString() || null }));
    res.json({ templates });
  } catch (err) {
    console.error('[nutrition] GET /templates error:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// ═══════════════════════════════════════════════════════════════
// DELETE /templates/:id — remove a template
// ═══════════════════════════════════════════════════════════════
router.delete('/templates/:id', async (req, res) => {
  try {
    const { deviceId } = req.query;
    const { id }       = req.params;
    if (!deviceId || !id) return res.status(400).json({ error: 'deviceId and id required' });
    await nutDoc(deviceId).collection('templates').doc(id).delete();
    res.json({ success: true });
  } catch (err) {
    console.error('[nutrition] DELETE /templates error:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /ai-insights — weekly GPT-4o generated insights
// ═══════════════════════════════════════════════════════════════
router.get('/ai-insights', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [nutSnap, profileSnap] = await Promise.all([
      nutDoc(deviceId).get(),
      userDoc(deviceId).get(),
    ]);
    if (!nutSnap.exists) return res.json({ insights: [] });

    const nutData  = nutSnap.data();
    const name     = profileSnap.exists ? (profileSnap.data().name || '') : '';
    const firstName = name.trim().split(' ')[0];

    // Fetch last 7 days of logs
    const weekAgo = dateStr(new Date(Date.now() - 7 * 86400000));
    const snap = await logsCol(deviceId).where('date_str', '>=', weekAgo).get();
    if (snap.empty) return res.json({ insights: [], reason: 'not_enough_data' });

    const byDay = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (!byDay[data.date_str]) byDay[data.date_str] = { cals: 0, prot: 0, carbs: 0, fat: 0, meals: [], entries: 0 };
      byDay[data.date_str].cals    += data.calories || 0;
      byDay[data.date_str].prot    += data.protein  || 0;
      byDay[data.date_str].carbs   += data.carbs    || 0;
      byDay[data.date_str].fat     += data.fat      || 0;
      byDay[data.date_str].entries += 1;
      if (data.food_name) byDay[data.date_str].meals.push(data.food_name);
    });

    const days = Object.keys(byDay).sort();
    const calTarget  = nutData.calorie_target || 2000;
    const protTarget = nutData.protein_target || 140;

    const daysSummary = days.map(d => {
      const b = byDay[d];
      return `${d}: ${Math.round(b.cals)}kcal / ${Math.round(b.prot)}g protein (${b.entries} entries)`;
    }).join('\n');

    const avgCals = Math.round(days.reduce((s, d) => s + byDay[d].cals, 0) / days.length);
    const protHit = days.filter(d => byDay[d].prot >= protTarget * 0.9).length;

    const prompt = `You are a precision nutrition coach analyzing a user's 7-day food log. Generate exactly 3 specific, data-driven insights that a stranger could NOT have said.

USER:
- Name: ${firstName || 'User'}
- Goal: ${nutData.goal || 'healthier'}
- Calorie target: ${calTarget} kcal/day
- Protein target: ${protTarget}g/day

7-DAY LOG:
${daysSummary}

Average calories: ${avgCals} kcal/day
Protein goal hit: ${protHit}/${days.length} days

Generate 3 insights. Rules:
- Each insight must reference specific days, numbers, or patterns from THEIR data
- Each must end with ONE concrete, actionable suggestion
- Keep each insight under 40 words
- Tone: direct coach, not cheerleader
- Format: return JSON array of strings

Return ONLY valid JSON: ["insight 1", "insight 2", "insight 3"]`;

    const completion = await openai.chat.completions.create({
      model: MODELS.fast, temperature: 0.5, max_tokens: 350,
      messages: [{ role: 'user', content: prompt }],
    });
    const insights = safeJSON(completion.choices[0].message.content, []);
    res.json({ insights: Array.isArray(insights) ? insights : [], days_analyzed: days.length, avg_cals: avgCals, protein_hit_days: protHit });
  } catch (err) {
    console.error('[nutrition] /ai-insights error:', err);
    res.status(500).json({ error: 'Insights failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ─── PROACTIVE CHECKS — 7am ───────────────────────────────────
// ═══════════════════════════════════════════════════════════════
async function runProactiveChecks() {
  console.log('[nutrition] running proactive checks');
  try {
    const usersSnap = await db()
      .collection('wellness_users')
      .where('nutrition_setup_complete', '==', true)
      .get();

    if (usersSnap.empty) return;

    const today = dateStr();

    for (const uDoc of usersSnap.docs) {
      const deviceId = uDoc.id;
      const userData = uDoc.data();

      if (userData.last_nutrition_proactive_date === today) continue;

      try {
        const nutSnap = await nutDoc(deviceId).get();
        if (!nutSnap.exists || !nutSnap.data().setup_completed) continue;

        const nutData   = nutSnap.data();
        // Also skip if an instant proactive already fired today
        if (nutData.last_proactive_date === today) continue;
        const { lastSleepHours, lastSleepDate, todayMoodAvg, todayMaxAnxiety } = await getCrossAgentData(deviceId);

        let msg  = null;
        let type = null;

        // Cross-agent morning brief (highest priority)
        if (lastSleepHours && lastSleepHours < 6 && lastSleepDate === dateStr(new Date(Date.now() - 86400000))) {
          const calTarget = nutData.calorie_target || 2000;
          const firstName = (userData.name || '').split(' ')[0];
          msg  = `${firstName ? firstName + ', ' : ''}your Sleep Coach shows you got ${lastSleepHours.toFixed(1)}h last night — under 6 hours triggers a cortisol response that drives sugar and fat cravings today. Your calorie budget is ${calTarget} kcal. Planning your meals now makes it 3× easier to stay on track. What's breakfast?`;
          type = 'sleep_cross_agent';
        }

        // Weekly protein summary (Monday morning)
        if (!msg && new Date().getDay() === 1) {
          const weekStart = dateStr(new Date(Date.now() - 7 * 86400000));
          const weekLogsSnap = await logsCol(deviceId)
            .where('date_str', '>=', weekStart).get();
          const weekLogs = weekLogsSnap.docs.map(d => d.data());
          const weekDays = new Set(weekLogs.map(l => l.date_str)).size;
          if (weekDays >= 4) {
            const avgProt = Math.round(weekLogs.reduce((s, l) => s + (l.protein || 0), 0) / weekDays * 10) / 10;
            const protTarget = nutData.protein_target || 140;
            const hit = avgProt >= protTarget * 0.9;
            msg  = `Last week: ${weekDays} days logged, ${avgProt}g avg protein${hit ? ` — protein goal hit, solid week` : ` — ${Math.round(protTarget - avgProt)}g short of your ${protTarget}g target daily`}. This week's focus: ${hit ? 'consistency' : 'protein at every meal'}.`;
            type = 'weekly_protein_summary';
          }
        }

        // Discussion topic (3x/week max, skip if already logged today)
        if (!msg) {
          const todayLogsSnap = await logsCol(deviceId).where('date_str', '==', today).limit(1).get();
          const alreadyLogged = !todayLogsSnap.empty;

          if (!alreadyLogged) {
            const topics    = nutData.discussion_topics || [];
            const weekKey   = getWeekKey();
            const sameWeek  = nutData.proactive_topic_week === weekKey;
            const weekCount = sameWeek ? (nutData.proactive_topic_week_count || 0) : 0;

            if (topics.length > 0 && weekCount < 3) {
              const topicIndex = nutData.proactive_topic_index || 0;
              const topic      = topics[topicIndex % topics.length];
              const firstName  = (userData.name || '').split(' ')[0];

              msg  = await buildTopicProactive(topic, firstName, nutData);
              type = 'discussion_topic';

              await nutDoc(deviceId).update({
                proactive_topic_index:      (topicIndex + 1) % topics.length,
                proactive_topic_week:       weekKey,
                proactive_topic_week_count: weekCount + 1,
              });
            }
          }
        }

        if (msg) {
          await chatsCol(deviceId).add({
            role: 'assistant', content: msg, is_proactive: true,
            proactive_type: type, is_read: false, date_str: today,
            created_at: admin.firestore.FieldValue.serverTimestamp(),
          });
          await userDoc(deviceId).update({ last_nutrition_proactive_date: today });
        }
      } catch (uErr) {
        console.error(`[nutrition] proactive failed for ${deviceId}:`, uErr.message);
      }
    }
  } catch (err) {
    console.error('[nutrition] proactive checks error:', err);
  }
}

// ─── Evening streak reminders — 8pm ──────────────────────────
async function runStreakReminders() {
  console.log('[nutrition] running evening streak reminders');
  try {
    const usersSnap = await db()
      .collection('wellness_users')
      .where('nutrition_setup_complete', '==', true)
      .get();

    if (usersSnap.empty) return;

    const today = dateStr();

    for (const uDoc of usersSnap.docs) {
      const deviceId = uDoc.id;
      const userData = uDoc.data();

      if (userData.last_nutrition_streak_reminder === today) continue;

      try {
        const nutSnap = await nutDoc(deviceId).get();
        if (!nutSnap.exists) continue;
        const nutData = nutSnap.data();

        const todayLogsSnap = await logsCol(deviceId).where('date_str', '==', today).limit(1).get();
        if (!todayLogsSnap.empty) continue;

        const streak = nutData.streak || 0;
        if (streak < 3) continue;

        const firstName = (userData.name || '').split(' ')[0];
        const msg = `Hey${firstName ? ' ' + firstName : ''} — no food logged today yet. Your ${streak}-day logging streak is at risk. Even logging one meal counts. What did you eat today?`;

        await chatsCol(deviceId).add({
          role: 'assistant', content: msg, is_proactive: true,
          proactive_type: 'streak_at_risk', is_read: false, date_str: today,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
        await userDoc(deviceId).update({ last_nutrition_streak_reminder: today });
      } catch (uErr) {
        console.error(`[nutrition] streak reminder failed for ${deviceId}:`, uErr.message);
      }
    }
  } catch (err) {
    console.error('[nutrition] streak reminders error:', err);
  }
}

async function buildTopicProactive(topic, firstName, nutData) {
  const challenge = Array.isArray(nutData.biggest_challenge) ? nutData.biggest_challenge.join(', ') : (nutData.biggest_challenge || 'nutrition');
  const prompt = `You are a warm, direct nutrition coach in a wellness app. Write ONE short message (2-3 sentences) to check in with a user about their nutrition topic.

User's first name: ${firstName || 'not given'}
Their biggest nutrition challenge: ${challenge}
Today's topic: ${topic}

Rules:
- Start with the topic naturally
- End with ONE specific question that invites them to respond
- Tone: direct and warm, like a coach who knows them
- Keep under 50 words
- No emojis, no "Hey I wanted to check in about..."

Return only the message text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODELS.fast, temperature: 0.7, max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return `${firstName ? firstName + ', ' : ''}you flagged ${topic.toLowerCase()} as something you want to work on. What's been the hardest part of that lately?`;
  }
}

// ═══════════════════════════════════════════════════════════════
// GET /habits — load this week's habit completion state
// ═══════════════════════════════════════════════════════════════
router.get('/habits', async (req, res) => {
  try {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const weekKey    = getWeekKey();
    const habitsCol  = nutDoc(deviceId).collection('habits');
    const snap       = await habitsCol.where('week_key', '==', weekKey).get();
    const completions = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.date_str) completions[data.date_str] = true;
    });
    res.json({ week_key: weekKey, completions });
  } catch (err) {
    console.error('[nutrition] GET /habits error:', err);
    res.status(500).json({ error: 'Failed to load habits' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /habits — mark today as done or undone
// ═══════════════════════════════════════════════════════════════
router.post('/habits', async (req, res) => {
  try {
    const { deviceId, done } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    const today     = dateStr();
    const weekKey   = getWeekKey();
    const habitsCol = nutDoc(deviceId).collection('habits');

    if (done) {
      const existing = await habitsCol.where('date_str', '==', today).limit(1).get();
      if (existing.empty) {
        await habitsCol.add({
          date_str: today, week_key: weekKey,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } else {
      const existing = await habitsCol.where('date_str', '==', today).limit(1).get();
      if (!existing.empty) await existing.docs[0].ref.delete();
    }

    const snap = await habitsCol.where('week_key', '==', weekKey).get();
    const completions = {};
    snap.docs.forEach(d => { const data = d.data(); if (data.date_str) completions[data.date_str] = true; });
    res.json({ success: true, completions });
  } catch (err) {
    console.error('[nutrition] POST /habits error:', err);
    res.status(500).json({ error: 'Failed to update habit' });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /analysis/weekly — week-by-week view, protein-first, positive framing
// ═══════════════════════════════════════════════════════════════
router.get('/analysis/weekly', async (req, res) => {
  try {
    const { deviceId, week } = req.query;
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

    const [nutSnap] = await Promise.all([nutDoc(deviceId).get()]);
    if (!nutSnap.exists) return res.json({ error: 'no_setup' });
    const nutData    = nutSnap.data();
    const calTarget  = nutData.calorie_target || 2000;
    const protTarget = nutData.protein_target || 140;

    // Build week start/end (Mon–Sun)
    const buildWeekBounds = (anchor) => {
      const d    = anchor ? new Date(anchor + 'T12:00:00') : new Date();
      const dow  = (d.getDay() + 6) % 7; // 0=Mon
      const mon  = new Date(d); mon.setDate(d.getDate() - dow); mon.setHours(0,0,0,0);
      const sun  = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23,59,59,999);
      return { mon, sun, monStr: dateStr(mon), sunStr: dateStr(sun) };
    };

    const current  = buildWeekBounds(week || null);
    const prevWeekAnchor = new Date(current.mon); prevWeekAnchor.setDate(current.mon.getDate() - 7);
    const previous = buildWeekBounds(dateStr(prevWeekAnchor));

    // Fetch 2 weeks of logs in one query
    const twoWeeksAgo = previous.monStr;
    const logsSnap = await logsCol(deviceId)
      .where('date_str', '>=', twoWeeksAgo)
      .where('date_str', '<=', current.sunStr)
      .get();

    const byDate = {};
    logsSnap.docs.forEach(d => {
      const data = d.data();
      if (!byDate[data.date_str]) byDate[data.date_str] = { cals: 0, prot: 0, carbs: 0, fat: 0, items: 0 };
      byDate[data.date_str].cals  += data.calories || 0;
      byDate[data.date_str].prot  += data.protein  || 0;
      byDate[data.date_str].carbs += data.carbs    || 0;
      byDate[data.date_str].fat   += data.fat      || 0;
      byDate[data.date_str].items += 1;
    });

    const buildWeekStats = (bounds) => {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d   = new Date(bounds.mon); d.setDate(bounds.mon.getDate() + i);
        const ds  = dateStr(d);
        const day = byDate[ds] || null;
        days.push({
          date:         ds,
          label:        d.toLocaleDateString('en', { weekday: 'short' }),
          logged:       !!day,
          calories:     day ? Math.round(day.cals)    : 0,
          protein:      day ? Math.round(day.prot * 10) / 10 : 0,
          carbs:        day ? Math.round(day.carbs * 10) / 10 : 0,
          fat:          day ? Math.round(day.fat  * 10) / 10 : 0,
          protein_hit:  day ? day.prot >= protTarget * 0.9 : false,
          cal_on_track: day ? (day.cals >= calTarget * 0.85 && day.cals <= calTarget * 1.15) : false,
        });
      }
      const loggedDays = days.filter(d => d.logged);
      const protDaysHit    = days.filter(d => d.protein_hit).length;
      const calDaysOnTrack = days.filter(d => d.cal_on_track).length;
      const avgCals   = loggedDays.length ? Math.round(loggedDays.reduce((s, d) => s + d.calories, 0) / loggedDays.length) : 0;
      const avgProt   = loggedDays.length ? Math.round(loggedDays.reduce((s, d) => s + d.protein, 0) / loggedDays.length * 10) / 10 : 0;
      const bestDay   = loggedDays.length ? loggedDays.reduce((a, b) => b.protein > a.protein ? b : a) : null;
      return { days, protDaysHit, calDaysOnTrack, avgCals, avgProt, bestDay, loggedCount: loggedDays.length };
    };

    const curr = buildWeekStats(current);
    const prev = buildWeekStats(previous);

    // Protein delta label (positive framing)
    const protDelta = curr.avgProt - prev.avgProt;
    const protDeltaLabel = prev.avgProt > 0
      ? (protDelta >= 0 ? `+${Math.round(protDelta)}g vs last week` : `${Math.round(protDelta)}g vs last week`)
      : null;

    // Generate AI insight (cached by week key, regenerated weekly)
    let ai_insight = null;
    const insightCacheKey = `weekly_${current.monStr}`;
    const cached = nutData.weekly_insight_cache;
    if (cached && cached.key === insightCacheKey) {
      ai_insight = cached.insight;
    } else if (curr.loggedCount >= 3) {
      try {
        const prompt = `Analyze this week of nutrition data and write a 2-sentence coach insight.

Week: ${current.monStr} to ${current.sunStr}
Protein target: ${protTarget}g/day
Calorie target: ${calTarget} kcal/day
Protein days hit: ${curr.protDaysHit}/7
Calories on track: ${curr.calDaysOnTrack}/7
Avg protein: ${curr.avgProt}g
Avg calories: ${curr.avgCals} kcal
Days logged: ${curr.loggedCount}/7
Best protein day: ${curr.bestDay ? curr.bestDay.label + ' (' + curr.bestDay.protein + 'g)' : 'none'}
Previous week avg protein: ${prev.avgProt}g

Rules — STRICT:
1. Sentence 1: MUST reference specific data (day name, number, percentage). Lead with what they did well.
2. Sentence 2: ONE specific, actionable opportunity framed as addition not subtraction.
3. MAX 2 sentences. Never more.
4. NEVER use: deficit, failed, missed, bad, poor, terrible, under, below, lack, didn't, not enough
5. USE: hit, achieved, strong, great, opportunity, adding, could push, on track, solid
6. Return only the 2-sentence insight. No preamble.`;

        const completion = await openai.chat.completions.create({
          model: MODELS.fast, temperature: 0.5, max_tokens: 120,
          messages: [{ role: 'user', content: prompt }],
        });
        ai_insight = completion.choices[0].message.content.trim();
        await nutDoc(deviceId).update({
          weekly_insight_cache: { key: insightCacheKey, insight: ai_insight, generated_at: new Date().toISOString() },
        });
      } catch { ai_insight = null; }
    }

    res.json({
      week_start:         current.monStr,
      week_end:           current.sunStr,
      protein_days_hit:   curr.protDaysHit,
      protein_days_total: 7,
      cal_days_on_track:  curr.calDaysOnTrack,
      avg_calories:       curr.avgCals,
      avg_protein:        curr.avgProt,
      protein_delta_label: protDeltaLabel,
      best_day:           curr.bestDay,
      daily_breakdown:    curr.days,
      logged_count:       curr.loggedCount,
      targets:            { calorie_target: calTarget, protein_target: protTarget },
      ai_insight,
      streak:             nutData.streak || 0,
    });
  } catch (err) {
    console.error('[nutrition] /analysis/weekly error:', err);
    res.status(500).json({ error: 'Weekly analysis failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /templates/:id/log — one-tap log a saved template to today
// ═══════════════════════════════════════════════════════════════
router.post('/templates/:id/log', async (req, res) => {
  try {
    const { deviceId, meal_type } = req.body;
    const { id } = req.params;
    if (!deviceId || !id) return res.status(400).json({ error: 'deviceId and id required' });

    const tmplSnap = await nutDoc(deviceId).collection('templates').doc(id).get();
    if (!tmplSnap.exists) return res.status(404).json({ error: 'Template not found' });

    const tmpl = tmplSnap.data();
    const today = dateStr();

    // Smart meal_type: use provided, or time-of-day default
    const hour = new Date().getHours();
    const defaultMeal = hour < 10 ? 'Breakfast' : hour < 15 ? 'Lunch' : hour < 18 ? 'Snacks' : 'Dinner';
    const resolvedMeal = meal_type || defaultMeal;

    // Log each item in the template
    const items = tmpl.items || [];
    const logRefs = await Promise.all(items.map(item =>
      logsCol(deviceId).add({
        food_name:  item.name || item.food_name || 'Food',
        emoji:      item.emoji || '🍽️',
        meal_type:  resolvedMeal,
        calories:   Math.round(item.calories || 0),
        protein:    Math.round((item.protein || 0) * 10) / 10,
        carbs:      Math.round((item.carbs   || 0) * 10) / 10,
        fat:        Math.round((item.fat     || 0) * 10) / 10,
        quantity:   item.quantity || 100,
        unit:       item.unit || 'g',
        source:     'template',
        template_id: id,
        date_str:   today,
        logged_at:  admin.firestore.FieldValue.serverTimestamp(),
      })
    ));

    // Increment use_count + update last_used
    await nutDoc(deviceId).collection('templates').doc(id).update({
      use_count: admin.firestore.FieldValue.increment(1),
      last_used: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Update streak
    const nutSnap = await nutDoc(deviceId).get();
    const nutData = nutSnap.data() || {};
    const yesterday = dateStr(new Date(Date.now() - 86400000));
    const last = nutData.last_log_date;
    const newStreak = (last === yesterday || last === today)
      ? (last === today ? (nutData.streak || 1) : (nutData.streak || 0) + 1) : 1;
    await nutDoc(deviceId).update({ last_log_date: today, streak: newStreak });

    _onNutritionLog(deviceId);
    refreshNutritionScore(deviceId).catch(() => {});

    res.json({
      success:    true,
      logged_ids: logRefs.map(r => r.id),
      meal_type:  resolvedMeal,
      streak:     newStreak,
      totals: {
        calories: tmpl.total_calories || 0,
        protein:  tmpl.total_protein  || 0,
        carbs:    tmpl.total_carbs    || 0,
        fat:      tmpl.total_fat      || 0,
      },
    });
  } catch (err) {
    console.error('[nutrition] POST /templates/:id/log error:', err);
    res.status(500).json({ error: 'Template log failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /voice/parse — voice transcript → structured food items
// Wrapper around parse-text with voice-specific cleaning
// ═══════════════════════════════════════════════════════════════
router.post('/voice/parse', async (req, res) => {
  try {
    const { deviceId, transcript } = req.body;
    if (!deviceId || !transcript) return res.status(400).json({ error: 'deviceId and transcript required' });

    // Fetch user context for personalised parsing (dietary style, goal)
    let userContext = {};
    try {
      const nutSnap = await nutDoc(deviceId).get();
      if (nutSnap.exists) {
        const d = nutSnap.data();
        userContext = {
          dietary_style: d.dietary_style || [],
          goal:          d.goal || '',
          allergies:     d.allergies || [],
        };
      }
    } catch { /* non-fatal */ }

    const dietaryNote = userContext.dietary_style?.length
      ? `User dietary style: ${userContext.dietary_style.join(', ')}. `
      : '';

    const parsePrompt = `You are a clinical nutrition AI with an encyclopedic knowledge of food composition.

${dietaryNote}Parse the user's voice description into EVERY individual food and drink item present.

━━━ ABSOLUTE RULES ━━━
1. "X with Y" ALWAYS = TWO separate items. NEVER merge them.
   • "toast with butter" → toast + butter (separate entries)
   • "oats with milk" → oats + milk (separate entries)
   • "chicken with rice" → chicken + rice (separate entries)
   • "coffee with milk and sugar" → coffee + milk + sugar (three entries)
2. Extract EVERY ingredient mentioned, no matter how small.
3. "a bit of", "some", "a little" = small standard portion.
4. If quantity not stated, use the most common single serving.
5. NEVER return 0 for calories/protein/carbs/fat — estimate realistically.
6. All macros must be consistent: calories ≈ protein×4 + carbs×4 + fat×9.

━━━ REFERENCE DATABASE (use exact values) ━━━
White toast 1 slice: 80 cal P3 C15 F1
Whole wheat toast 1 slice: 70 cal P4 C12 F1
Butter 1 tsp (5g): 36 cal P0 C0 F4
Butter 1 tbsp (14g): 102 cal P0 C0 F12
Jam/jelly 1 tbsp: 56 cal P0 C14 F0
Scrambled eggs 2 large: 182 cal P12 C2 F14
Fried egg 1 large: 90 cal P6 C0 F7
Boiled egg 1 large: 78 cal P6 C1 F5
Oatmeal 1 cup cooked: 158 cal P6 C27 F3
Milk whole 1 cup (240ml): 149 cal P8 C12 F8
Milk skimmed 1 cup: 83 cal P8 C12 F0
Banana medium: 105 cal P1 C27 F0
Apple medium: 95 cal P0 C25 F0
Greek yogurt plain 200g: 130 cal P17 C8 F0
Granola 50g: 224 cal P5 C34 F8
Chicken breast 150g grilled: 248 cal P46 C0 F5
Chicken thigh 120g: 224 cal P22 C0 F15
Rice white cooked 1 cup (186g): 242 cal P4 C53 F0
Rice brown cooked 1 cup: 216 cal P5 C45 F2
Roti/chapati 1 medium (40g): 120 cal P3 C20 F3
Paratha 1 medium (80g): 260 cal P5 C32 F12
Dal cooked 1 cup: 230 cal P18 C40 F1
Pasta cooked 1 cup (140g): 220 cal P8 C43 F1
Bread white 1 slice: 80 cal P3 C15 F1
Cheese cheddar 30g: 120 cal P7 C0 F10
Protein shake 1 scoop (30g): 120 cal P24 C3 F2
Oat milk 240ml: 120 cal P3 C16 F5
Almond milk 240ml: 39 cal P1 C3 F3
Coffee black: 2 cal P0 C0 F0
Espresso single: 3 cal P0 C0 F0
Orange juice 250ml: 112 cal P2 C26 F0
Avocado half (75g): 120 cal P1 C6 F11
Salmon 150g cooked: 280 cal P40 C0 F13
Tuna canned 85g: 109 cal P25 C0 F1
Salad leaves 60g: 12 cal P1 C2 F0
Olive oil 1 tbsp: 119 cal P0 C0 F14
Honey 1 tsp: 21 cal P0 C6 F0
Sugar 1 tsp: 16 cal P0 C4 F0
Peanut butter 2 tbsp: 188 cal P8 C6 F16
Almonds 30g (small handful): 173 cal P6 C6 F15
Protein bar (average): 200 cal P20 C22 F7

Transcript: "${transcript}"

Return ONLY this JSON (no markdown, no explanation):
{
  "items": [
    {
      "name": "food name (short, clear)",
      "quantity": 1,
      "unit": "slice|g|ml|piece|cup|tbsp|tsp|scoop|serving",
      "emoji": "🍞",
      "confidence": "high|medium|low",
      "calories": 80,
      "protein": 3,
      "carbs": 15,
      "fat": 1
    }
  ]
}`;

    const parseResp = await openai.chat.completions.create({
      model: MODELS.fast,
      temperature: 0.1,
      max_tokens: 800,
      messages: [{ role: 'user', content: parsePrompt }],
    });

    const parsed = safeJSON(parseResp.choices[0].message.content, { items: [] });
    const items  = (parsed.items || []).filter(
      i => i.name && typeof i.calories === 'number' && i.calories > 0,
    );

    // Detect vague items that need clarification
    const VAGUE_TERMS = new Set([
      'snack', 'snacks', 'something', 'food', 'stuff', 'things', 'meal',
      'lunch', 'dinner', 'breakfast', 'drink', 'beverage', 'dessert',
      'some food', 'some snacks', 'leftovers', 'a bite', 'bites',
    ]);

    const CLARIFICATION_QUESTIONS = {
      snack: 'What kind of snack? (e.g. biscuits, nuts, chips, fruit, crackers)',
      snacks: 'What kind of snacks? (e.g. biscuits, nuts, chips, fruit)',
      drink: 'What drink exactly? (e.g. tea with milk, black coffee, juice, water)',
      beverage: 'What drink exactly? (e.g. tea with milk, juice, soda)',
      dessert: 'What dessert? (e.g. ice cream, cake slice, chocolate, cookie)',
      meal: 'What was in the meal? (e.g. rice and chicken, pasta, salad)',
      something: 'What food specifically? Describe it briefly.',
      stuff: 'What food specifically? Describe it briefly.',
      leftovers: 'What were the leftovers? (e.g. yesterday\'s chicken rice)',
    };

    const clarifications = [];
    for (const item of items) {
      const key = item.name?.toLowerCase().trim();
      const isVague = VAGUE_TERMS.has(key) || item.confidence === 'low';
      if (isVague) {
        const question = CLARIFICATION_QUESTIONS[key] || `What exactly did you have as "${item.name}"? Be specific for accuracy.`;
        clarifications.push({
          item_name:   item.name,
          item_emoji:  item.emoji || '🍽️',
          question,
        });
      }
    }

    res.json({ original_transcript: transcript, items, clarifications });
  } catch (err) {
    console.error('[nutrition] /voice/parse error:', err);
    res.status(500).json({ error: 'Voice parsing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ─── CRON ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
cron.schedule('0 7 * * *',  () => { runProactiveChecks(); });
cron.schedule('0 20 * * *', () => { runStreakReminders(); });

console.log('[nutrition] agent loaded ✓ — proactive cron active at 7am (full) / 8pm (streak)');

module.exports = router;
