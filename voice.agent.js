'use strict';
// ════════════════════════════════════════════════════════════════
// voice.agent.js — POST /api/voice/transcribe
//
// Cloud Whisper fallback for the dual-strategy FE voice manager.
// FE Strategy A (@react-native-voice/voice) handles the happy path
// on-device. When native is unavailable (silent OEM RecognitionService
// failure, no Google Search app, locale not supported) the FE falls
// back to recording audio + uploading here, where Whisper does the
// transcription server-side.
//
// Request (multipart/form-data):
//   - audio    File   the recorded audio (m4a / mp4 / wav)
//   - language String ISO-639-1 hint ("en"|"es"|"fr"|"de"|"pt"|"ru")
//   - agent    String analytics tag ("fitness"|"sleep"|"mind"|"nutrition"|"fasting")
//
// Response 200:
//   { text: string, durationSec: number, model: 'whisper-1', strategy: 'cloud' }
//
// Response 4xx/5xx:
//   { error: string, code: string }
//
// Cost note: Whisper API is $0.006/min. With native succeeding on the
// vast majority of users (after the Android <queries> manifest fix),
// cloud is a true fallback — projected <5% of voice sessions.
// ════════════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');

const router = express.Router();

// Store uploads in OS temp dir; clean up after each request.
const upload = multer({
  dest: path.join(os.tmpdir(), 'voice-uploads'),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB — Whisper's hard limit. Most voice clips are <2MB.
    files: 1,
  },
});

const SUPPORTED_LANGS = new Set(['en', 'es', 'fr', 'de', 'pt', 'ru']);

// Lazy OpenAI client — construct on first use so server.js can boot in
// environments without OPENAI_API_KEY (tests, local dev without secrets).
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

function cleanup(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  const t0 = Date.now();
  const file = req.file;
  const language = SUPPORTED_LANGS.has(String(req.body?.language || '').toLowerCase())
    ? String(req.body.language).toLowerCase()
    : undefined; // let Whisper auto-detect when unsupported
  const agent = String(req.body?.agent || 'unknown').slice(0, 32);

  if (!file) {
    return res.status(400).json({ error: 'audio file required', code: 'no_audio' });
  }
  if (!process.env.OPENAI_API_KEY) {
    cleanup(file.path);
    return res.status(500).json({ error: 'server misconfigured', code: 'no_api_key' });
  }

  try {
    log.info('[voice:transcribe]', {
      agent,
      language: language || 'auto',
      size_bytes: file.size,
      mime: file.mimetype,
    });

    const stream = fs.createReadStream(file.path);
    const result = await getOpenAI().audio.transcriptions.create({
      file: stream,
      model: 'whisper-1',
      language, // optional; Whisper auto-detects when undefined
      response_format: 'json',
    });

    const text = String(result?.text || '').trim();
    const durationSec = (Date.now() - t0) / 1000;

    cleanup(file.path);

    log.info('[voice:transcribe] ok', {
      agent,
      chars: text.length,
      duration_sec: durationSec,
    });

    return res.json({
      text,
      durationSec,
      model: 'whisper-1',
      strategy: 'cloud',
    });
  } catch (e) {
    cleanup(file.path);
    log.warn('[voice:transcribe] fail', {
      agent,
      err: e?.message || String(e),
      code: e?.code || 'whisper_error',
    });
    return res.status(500).json({
      error: 'transcription_failed',
      code: e?.code || 'whisper_error',
    });
  }
});

module.exports = router;
