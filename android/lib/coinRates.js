'use strict';

// ═══════════════════════════════════════════════════════════════
// coinRates.js — Single source of truth for earn/spend amounts.
//
// FE and BE both use these constants so client UI and server credits
// can't drift. Values locked in ANDROID_COINS_ADS_REFERRALS_400H_PLAN.md §3.
// ═══════════════════════════════════════════════════════════════

// Earn sources — frozen taxonomy. Adding a new source requires:
//   1. add to EARN_SOURCES below
//   2. add to EARN_RATES with amount + daily cap
//   3. update FE caller in StillAlive/src/android/coins/
//   4. update Mixpanel `Android Coin Earned` schema if `meta` changes
const EARN_SOURCES = Object.freeze({
  ONBOARDING_COMPLETE:     'onboarding_complete',
  MANUAL_LOG:              'manual_log',                  // meta.coach: 'sleep'|'mind'|...
  SIX_OF_SIX_DAILY:        'six_of_six_daily',
  STREAK_7_DAYS:           'streak_7_days',
  STREAK_30_DAYS:          'streak_30_days',
  PLAN_DAILY_CHECKIN:      'plan_daily_checkin',
  PLAN_COMPLETED:          'plan_completed',              // meta.plan_id
  REFERRAL_BONUS_REFERRER: 'referral_bonus_referrer',     // meta.referee_device_id
  REFERRAL_BONUS_REFEREE:  'referral_bonus_referee',      // meta.referrer_device_id
  REWARDED_VIDEO_WATCHED:  'rewarded_video_watched',      // meta.ad_unit, meta.ssv_event_id
  REWARDED_INT_WATCHED:    'rewarded_int_watched',
  DAILY_COLD_START:        'daily_cold_start',
  DAILY_CHECKIN_AD:        'daily_checkin_ad',            // +50 after watching rewarded ad on daily check-in
  MONTHLY_CONSISTENCY_2X:  'monthly_consistency_2x',      // 30-day streak: doubles earned that month
});

// Spend features — frozen. Same rules as EARN_SOURCES.
const SPEND_FEATURES = Object.freeze({
  AI_COACH_QUESTION:        'ai_coach_question',
  AI_DEEP_ANALYSIS:         'ai_deep_analysis',
  VOICE_DESCRIBE:           'voice_describe',
  CAMERA_MEAL_LOG:          'camera_meal_log',
  CAMERA_WATER_LOG:         'camera_water_log',
  CAMERA_NUTRITION_LABEL:   'camera_nutrition_label',
  CUSTOM_PLAN:              'custom_plan',
  WEEKLY_DEEP_ANALYSIS:     'weekly_deep_analysis',
  CROSS_AGENT_INSIGHTS:     'cross_agent_insights',
});

// EARN_RATES — amount per event + daily caps.
// dailyMax: total times per day this source can credit coins (per device).
// perCoachDailyMax (only for MANUAL_LOG): per-coach daily cap.
// lifetimeMax: optional all-time cap (used for one-time bonuses).
const EARN_RATES = Object.freeze({
  // No starter giveaway (2026-05-31 new economy): user earns from day 1 via
  // logging actions, each of which credits up to a per-coach ceiling.
  // Kept as 0/lifetime:1 so the source stays in the registry but credits nothing.
  [EARN_SOURCES.ONBOARDING_COMPLETE]:     { amount: 0,    lifetimeMax: 1 },
  [EARN_SOURCES.MANUAL_LOG]:              { amount: 10,   dailyMax: 30, perCoachDailyMax: 5 },
  [EARN_SOURCES.SIX_OF_SIX_DAILY]:        { amount: 100,  dailyMax: 1 },
  [EARN_SOURCES.STREAK_7_DAYS]:           { amount: 500,  dailyMax: 1 },  // engine guards re-fire
  [EARN_SOURCES.STREAK_30_DAYS]:          { amount: 2500, dailyMax: 1 },
  [EARN_SOURCES.PLAN_DAILY_CHECKIN]:      { amount: 25,   dailyMax: 4 },  // 4 tasks/day max
  [EARN_SOURCES.PLAN_COMPLETED]:          { amount: 1000 },               // dedupe by plan_id
  [EARN_SOURCES.REFERRAL_BONUS_REFERRER]: { amount: 200,  lifetimeMax: 50 }, // 50 referrals lifetime
  [EARN_SOURCES.REFERRAL_BONUS_REFEREE]:  { amount: 200,  lifetimeMax: 1 },
  // AdMob policy P1 (2026-05-31): reduced rewarded daily from 20 → 15 to stay
  // safely below the algorithmic fill-rate throttle Google applies on heavy
  // rewarded users in India (~15-20/day). 15 is the industry-safe ceiling.
  [EARN_SOURCES.REWARDED_VIDEO_WATCHED]:  { amount: 50,   dailyMax: 15, cooldownSec: 120 },
  [EARN_SOURCES.REWARDED_INT_WATCHED]:    { amount: 20,   dailyMax: 10, cooldownSec: 180 },
  [EARN_SOURCES.DAILY_COLD_START]:        { amount: 25,   dailyMax: 1 },
  [EARN_SOURCES.DAILY_CHECKIN_AD]:        { amount: 50,   dailyMax: 1 },  // requires rewarded ad in same flow
  [EARN_SOURCES.MONTHLY_CONSISTENCY_2X]:  { amount: 0 },                  // amount computed by engine (sum of past 30d earns)
});

const SPEND_PRICES = Object.freeze({
  [SPEND_FEATURES.AI_COACH_QUESTION]:      20,
  [SPEND_FEATURES.AI_DEEP_ANALYSIS]:       50,
  [SPEND_FEATURES.VOICE_DESCRIBE]:         30,
  [SPEND_FEATURES.CAMERA_MEAL_LOG]:        40,
  [SPEND_FEATURES.CAMERA_WATER_LOG]:       20,
  [SPEND_FEATURES.CAMERA_NUTRITION_LABEL]: 30,
  [SPEND_FEATURES.CUSTOM_PLAN]:            200,
  [SPEND_FEATURES.WEEKLY_DEEP_ANALYSIS]:   100,
  [SPEND_FEATURES.CROSS_AGENT_INSIGHTS]:   50,
});

// Theoretical daily earn ceiling for an honest engaged user (for capacity planning):
//   30 manual logs + 100 + 25 cold-start + 100 plan checkins + 20 rewarded + 10 rewarded int
//   + occasional streak hit (500 weekly) = ~1700/day cap
// Spend ceiling at 20/AI question = ~85 AI questions/day. Aligns with §0.2.

module.exports = {
  EARN_SOURCES,
  SPEND_FEATURES,
  EARN_RATES,
  SPEND_PRICES,
};
