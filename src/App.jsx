import { useState, useEffect, useRef, useCallback } from "react";

// ─── KNOWN LIMITATIONS ───────────────────────────────────────────────────────
// 1. CBCA/RM/LIWC achieves ~67-70% accuracy — probabilistic patterns, not verdicts.
// 2. Local signal computation is heuristic word-category counting.
// 3. html2canvas requires `npm install html2canvas`. Falls back to text copy.
// 4. Clipboard image write requires HTTPS. Falls back to PNG download on localhost.
// 5. Session history uses localStorage — won't persist in Claude preview sandbox.
// 6. Daily limit is browser-based via localStorage — bypassable with incognito.
// 7. Speech recognition is Chrome/Edge only.
// ─────────────────────────────────────────────────────────────────────────────

const FONTS = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500&family=Outfit:wght@300;400;500;600&display=swap');`;

const FPS_WORDS = ["i","me","my","mine","myself"];
const EXCLUSIVE = ["but","except","without","although","however","unless","yet","despite","whereas","rather","instead","excluding","apart","other than"];
const SENSORY = ["saw","see","seen","heard","hear","felt","feel","touched","touch","smelled","smell","tasted","taste","noticed","notice","watched","watch","looked","look","sounded","sound"];
const TEMPORAL = ["then","when","after","before","during","while","suddenly","immediately","first","next","later","earlier","once","soon","already","still","just","always","never","eventually","finally","meanwhile","at that point","at the time","right after","seconds later"];
const SPATIAL = ["there","here","near","far","left","right","behind","front","beside","next to","across","above","below","inside","outside","between","around","against","toward","away","through","over","under","corner","edge","middle","center"];
const COGNITIVE_OPS = ["thought","think","imagined","imagine","wondered","wonder","knew","know","believed","believe","guessed","guess","decided","decide","wanted","want","remembered","remember","assumed","assume","expected","expect","realized","realize","figured","figure","supposed","suppose"];
const NEGATIVE_EMO = ["hate","angry","anger","wrong","bad","terrible","awful","hurt","painful","unfortunate","unhappy","sad","upset","frustrated","annoyed","disgusted","disappointed","regret","sorry","scared","afraid","worried","anxious","stressed","failed","failure","mistake","horrible","dreadful","unpleasant"];
const COMPLICATION_MARKERS = ["because","since","therefore","which means","as a result","so that","leading to","causing","due to","that's why","this caused","the reason","consequently","thus"];
const SELF_HANDICAP = ["i'm not sure","i don't remember","i can't remember","i'm not certain","i might be wrong","i may have","hard to say","not exactly sure","can't recall","don't recall","memory isn't great","might not be right"];
const CORRECTIONS = ["actually","wait no","i mean","correction","let me rephrase","no wait","sorry","i should say","to be more accurate","more accurately","to clarify","what i meant"];
const FILLER_WORDS = ["um","uh","like","you know","basically","literally","actually","sort of","kind of","i mean","right","okay so","so","well"];
const HEDGE_PHRASES = ["i think","i believe","maybe","perhaps","might","could be","not sure","i guess","probably","possibly"];

const DIMENSIONS = ["Conviction","Clarity","Composure","Connection"];
const DAILY_LIMIT = 10;
const MIN_WORDS = 25;
const MIN_SECONDS = 12;
const STORAGE_KEY = "cue_sessions_v2";

const getDailyKey = () => `cue_daily_${new Date().toISOString().split("T")[0]}`;
const getDailyCount = () => { try { return parseInt(localStorage.getItem(getDailyKey()) || "0", 10); } catch { return 0; } };
const incDailyCount = () => { try { const n = getDailyCount() + 1; localStorage.setItem(getDailyKey(), n); return n; } catch { return 1; } };
const loadSessions = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; } };
const saveSessions = (s) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s.slice(0, 20))); } catch {} };

function computeSignals(text, elapsed) {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const total = words.length;
  if (total === 0) return null;
  const fps = words.filter(w => FPS_WORDS.includes(w)).length;
  const fpsRate = ((fps / total) * 100).toFixed(1);
  const exclusive = words.filter(w => EXCLUSIVE.includes(w)).length;
  const exclusiveRate = ((exclusive / total) * 100).toFixed(1);
  const sensory = words.filter(w => SENSORY.includes(w)).length;
  const temporal = words.filter(w => TEMPORAL.includes(w)).length;
  const spatial = words.filter(w => SPATIAL.includes(w)).length;
  const cogOps = words.filter(w => COGNITIVE_OPS.includes(w)).length;
  const rmTruth = sensory + temporal + spatial;
  const rmRatio = cogOps > 0 ? (rmTruth / cogOps).toFixed(2) : "∞";
  const negEmo = words.filter(w => NEGATIVE_EMO.includes(w)).length;
  const negEmoRate = ((negEmo / total) * 100).toFixed(1);
  const complications = COMPLICATION_MARKERS.filter(p => lower.includes(p)).length;
  const selfHandicap = SELF_HANDICAP.filter(p => lower.includes(p)).length;
  const corrections = CORRECTIONS.filter(p => lower.includes(p)).length;
  const fillers = words.filter(w => FILLER_WORDS.includes(w)).length;
  const fillerRate = ((fillers / total) * 100).toFixed(1);
  const hedges = HEDGE_PHRASES.filter(p => lower.includes(p)).length;
  const wpm = elapsed > 0 ? Math.round((total / elapsed) * 60) : 0;
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  const wordsPerSentence = sentences > 0 ? (total / sentences).toFixed(1) : 0;
  return {
    total, elapsed, wpm, sentences, wordsPerSentence,
    fpsRate, fpsCount: fps, exclusiveRate, exclusiveCount: exclusive,
    sensory, temporal, spatial, cogOps, rmTruth, rmRatio,
    negEmoRate, negEmoCount: negEmo,
    complications, selfHandicap, corrections,
    fillerRate, fillerCount: fillers, hedges,
    lowFPS: parseFloat(fpsRate) < 3.5,
    highCogOps: cogOps > (rmTruth * 0.6),
    highFillers: parseFloat(fillerRate) > 6,
    lowExclusive: exclusive < 2 && total > 80,
    richSensory: sensory >= 3,
    hasComplications: complications >= 2,
    hasSelfHandicap: selfHandicap >= 1,
    hasCorrections: corrections >= 1,
  };
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const css = `
${FONTS}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: #F4F1EA;
  --surface: #FDFBF7;
  --forest: #1C3A2E;
  --forest-mid: #2D5C46;
  --forest-light: rgba(28,58,46,0.06);
  --gold: #B8822A;
  --gold-light: #E8C47A;
  --gold-dim: rgba(184,130,42,0.12);
  --text: #1a1a1e;
  --text-secondary: #4a4a54;
  --muted: #8C8878;
  --border: rgba(28,58,46,0.10);
  --border-strong: rgba(28,58,46,0.20);
  --ff-display: 'Fraunces', serif;
  --ff-body: 'Outfit', sans-serif;
  --shadow-sm: 0 1px 8px rgba(28,58,46,0.06);
  --shadow: 0 2px 16px rgba(28,58,46,0.08);
  --shadow-lg: 0 8px 40px rgba(28,58,46,0.13);
  --red: #D94F4F;
  --green: #2D8C5A;
  --r: 16px;
}

body { background: var(--bg); }

/* ── GRAIN TEXTURE OVERLAY ── */
.cue-app {
  min-height: 100vh;
  background: var(--bg);
  font-family: var(--ff-body);
  color: var(--text);
  position: relative;
  overflow-x: hidden;
}
.cue-app::before {
  content: '';
  position: fixed; inset: 0;
  background:
    radial-gradient(ellipse 70% 50% at 85% 5%, rgba(184,130,42,0.09) 0%, transparent 55%),
    radial-gradient(ellipse 60% 60% at 5% 95%, rgba(28,58,46,0.07) 0%, transparent 55%),
    radial-gradient(ellipse 40% 40% at 50% 50%, rgba(184,130,42,0.03) 0%, transparent 60%);
  pointer-events: none; z-index: 0;
}
.cue-app::after {
  content: '';
  position: fixed; inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='250'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.78' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='250' height='250' filter='url(%23n)'/%3E%3C/svg%3E");
  opacity: 0.028;
  pointer-events: none; z-index: 0;
}

/* ── SCREENS ── */
.screen { position: relative; z-index: 1; }
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(14px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; } to { opacity: 1; }
}

/* ── NAV ── */
.nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 22px 32px 20px;
  border-bottom: 1px solid var(--border);
  position: relative; z-index: 10;
  background: rgba(244,241,234,0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.wordmark {
  font-family: var(--ff-display); font-size: 26px; font-weight: 600;
  color: var(--forest); letter-spacing: -0.5px; cursor: pointer;
  transition: opacity 0.2s; user-select: none;
}
.wordmark:hover { opacity: 0.65; }
.wordmark span { color: var(--gold); }
.nav-right { display: flex; align-items: center; gap: 12px; }
.nav-tag {
  font-size: 10px; font-weight: 600; letter-spacing: 2.5px;
  text-transform: uppercase; color: var(--muted);
}
.history-nav-btn {
  padding: 7px 15px; border: 1px solid var(--border-strong);
  border-radius: 100px; background: transparent;
  font-family: var(--ff-body); font-size: 11px; font-weight: 500;
  color: var(--muted); cursor: pointer; transition: all 0.2s;
  letter-spacing: 0.3px;
}
.history-nav-btn:hover { color: var(--forest); border-color: var(--forest); background: var(--forest-light); }

/* ── BROWSER WARNING ── */
.browser-warn {
  max-width: 460px; margin: 72px auto; padding: 0 32px; text-align: center;
  animation: fadeUp 0.5s both;
}
.browser-warn-icon { font-size: 44px; margin-bottom: 20px; }
.browser-warn-headline {
  font-family: var(--ff-display); font-size: 26px; font-weight: 500;
  color: var(--forest); letter-spacing: -0.5px; margin-bottom: 14px;
}
.browser-warn-sub {
  font-size: 15px; color: var(--muted); line-height: 1.75;
  font-weight: 400; margin-bottom: 28px;
}
.browser-warn-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 12px 24px; background: var(--forest);
  color: #F4F1EA; border-radius: 100px; font-size: 13px; font-weight: 500;
}

/* ── HOME SCREEN ── */
.home {
  max-width: 600px; margin: 0 auto;
  padding: 56px 32px 80px; text-align: center;
}
.home-eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: 3px;
  text-transform: uppercase; color: var(--gold); margin-bottom: 22px;
  animation: fadeUp 0.5s 0.05s both;
}
.home-headline {
  font-family: var(--ff-display);
  font-size: clamp(44px, 8.5vw, 72px);
  font-weight: 500; line-height: 1.04;
  color: var(--forest); letter-spacing: -2.5px;
  margin-bottom: 22px;
  animation: fadeUp 0.65s 0.15s both;
}
.home-headline em { font-style: italic; color: var(--gold); }
.home-sub {
  font-size: 16px; line-height: 1.75; color: var(--muted);
  max-width: 420px; margin: 0 auto 48px;
  font-weight: 400;
  animation: fadeUp 0.55s 0.28s both;
}
.home-cta-wrap {
  animation: fadeUp 0.5s 0.38s both;
  display: flex; flex-direction: column; align-items: center; gap: 14px;
}
.start-btn {
  display: inline-flex; align-items: center; gap: 12px;
  background: var(--forest); color: #F4F1EA;
  border: none; border-radius: 100px;
  padding: 17px 38px; font-family: var(--ff-body);
  font-size: 16px; font-weight: 500; cursor: pointer;
  transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
  box-shadow: 0 4px 20px rgba(28,58,46,0.22), 0 1px 4px rgba(28,58,46,0.12);
  letter-spacing: 0.2px;
}
.start-btn:hover:not(:disabled) {
  background: var(--forest-mid);
  transform: translateY(-2px);
  box-shadow: 0 8px 28px rgba(28,58,46,0.28);
}
.start-btn:active:not(:disabled) { transform: scale(0.98) translateY(0); }
.start-btn:disabled { opacity: 0.38; cursor: not-allowed; }
.start-btn-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--red);
  box-shadow: 0 0 0 3px rgba(217,79,79,0.2);
}
.rate-note { font-size: 12px; color: var(--muted); font-weight: 400; }
.rate-note.warn { color: var(--gold); font-weight: 500; }
.rate-note.blocked { color: var(--red); font-weight: 500; }
.home-pillars {
  display: flex; justify-content: center; gap: 8px;
  margin-top: 52px; flex-wrap: wrap;
  animation: fadeUp 0.5s 0.52s both;
}
.pillar-chip {
  padding: 8px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 100px; font-size: 12px; font-weight: 500;
  color: var(--forest); background: rgba(255,255,255,0.55);
  transition: all 0.18s; cursor: default; letter-spacing: 0.2px;
}
.pillar-chip:hover { background: var(--forest-light); border-color: var(--forest); }

/* ── RECORDING SCREEN ── */
.record-screen { max-width: 680px; margin: 0 auto; padding: 20px 24px 72px; animation: fadeIn 0.3s both; }
.session-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 16px; padding: 14px 20px;
  background: var(--surface); border-radius: var(--r);
  border: 1px solid var(--border); box-shadow: var(--shadow-sm);
}
.session-status { display: flex; align-items: center; gap: 10px; }
.rec-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--red); box-shadow: 0 0 0 3px rgba(217,79,79,0.18);
  animation: recPulse 1.4s ease-in-out infinite;
}
@keyframes recPulse {
  0%,100% { box-shadow: 0 0 0 3px rgba(217,79,79,0.18); }
  50%      { box-shadow: 0 0 0 7px rgba(217,79,79,0.04); }
}
.session-label { font-size: 13px; font-weight: 600; color: var(--forest); letter-spacing: 0.2px; }
.timer-display {
  font-family: var(--ff-display); font-size: 21px;
  font-weight: 400; color: var(--forest); letter-spacing: -0.5px;
}
.waveform-card {
  border-radius: 20px; padding: 28px 20px; margin-bottom: 14px;
  background: var(--forest);
  background-image:
    radial-gradient(circle at 20% 50%, rgba(184,130,42,0.12) 0%, transparent 50%),
    radial-gradient(circle at 80% 50%, rgba(45,92,70,0.4) 0%, transparent 50%);
  position: relative; overflow: hidden;
}
.waveform-card::after {
  content: '';
  position: absolute; inset: 0;
  background: repeating-linear-gradient(
    90deg, transparent 0px, transparent 10px,
    rgba(255,255,255,0.012) 10px, rgba(255,255,255,0.012) 11px
  );
  pointer-events: none;
}
.waveform { display: flex; align-items: center; gap: 3px; height: 68px; justify-content: center; position: relative; z-index: 1; }
.wbar { width: 4px; border-radius: 10px; background: var(--gold-light); min-height: 4px; transition: height 0.08s ease; }

.min-guard {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 12px; padding: 10px 16px;
  background: var(--gold-dim); border-radius: 10px;
  font-size: 13px; color: var(--gold); font-weight: 400;
}
.min-guard-bar {
  flex: 1; height: 3px; background: rgba(184,130,42,0.2); border-radius: 2px; overflow: hidden;
}
.min-guard-fill {
  height: 100%; background: var(--gold); border-radius: 2px; transition: width 1s linear;
}

.transcript-card {
  background: var(--surface); border-radius: var(--r);
  border: 1px solid var(--border); padding: 18px 20px;
  margin-bottom: 14px; box-shadow: var(--shadow-sm);
  position: relative;
}
.transcript-card::after {
  content: '';
  position: absolute; bottom: 0; left: 0; right: 0; height: 36px;
  background: linear-gradient(to top, var(--surface), transparent);
  border-radius: 0 0 var(--r) var(--r);
  pointer-events: none;
}
.transcript-label {
  font-size: 10px; font-weight: 600; letter-spacing: 2px;
  text-transform: uppercase; color: var(--muted); margin-bottom: 12px;
}
.transcript-text {
  font-size: 15px; line-height: 1.8; color: var(--text);
  min-height: 76px; max-height: 152px; overflow-y: auto; font-weight: 400;
}
.transcript-text::-webkit-scrollbar { width: 3px; }
.transcript-text::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }
.placeholder-text { color: var(--muted); font-style: italic; font-weight: 300; }
.word-filler { background: rgba(184,130,42,0.14); color: #8B5E1A; border-radius: 3px; padding: 0 3px; }
.word-hedge { background: rgba(28,58,46,0.07); color: var(--forest-mid); border-radius: 3px; padding: 0 3px; }
.word-interim { opacity: 0.42; }

.metrics-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
@media (max-width: 580px) { .metrics-row { grid-template-columns: repeat(2, 1fr); } }
.metric-chip {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow-sm);
}
.metric-chip-label {
  font-size: 10px; font-weight: 600; letter-spacing: 1.5px;
  text-transform: uppercase; color: var(--muted); margin-bottom: 5px;
}
.metric-chip-value {
  font-family: var(--ff-display); font-size: 22px;
  font-weight: 500; color: var(--forest); line-height: 1;
}
.metric-chip-sub { font-size: 10px; color: var(--muted); margin-top: 3px; font-weight: 400; }

.record-controls { display: flex; gap: 10px; }
.stop-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
  padding: 15px; background: var(--forest); color: #F4F1EA;
  border: none; border-radius: 14px; font-family: var(--ff-body);
  font-size: 15px; font-weight: 500; cursor: pointer;
  transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
  box-shadow: var(--shadow);
}
.stop-btn:hover:not(:disabled) { background: var(--forest-mid); transform: translateY(-1px); box-shadow: var(--shadow-lg); }
.stop-btn:active:not(:disabled) { transform: scale(0.99); }
.stop-btn:disabled { opacity: 0.38; cursor: not-allowed; box-shadow: none; }
.stop-square { width: 11px; height: 11px; background: var(--red); border-radius: 3px; flex-shrink: 0; }
.cancel-btn {
  padding: 15px 20px; background: transparent; color: var(--muted);
  border: 1px solid var(--border-strong); border-radius: 14px;
  font-family: var(--ff-body); font-size: 14px; font-weight: 500;
  cursor: pointer; transition: all 0.18s;
}
.cancel-btn:hover { color: var(--text); border-color: var(--forest); background: var(--forest-light); }
.cancel-btn:active { transform: scale(0.98); }

/* ── ANALYZING SCREEN ── */
.analyzing-screen {
  max-width: 440px; margin: 80px auto; padding: 0 24px; text-align: center;
  animation: fadeUp 0.4s both;
}
.analyzing-wordmark {
  font-family: var(--ff-display); font-size: 20px; font-weight: 500;
  color: var(--gold); letter-spacing: -0.5px; margin-bottom: 32px; opacity: 0.8;
}
.analyzing-headline {
  font-family: var(--ff-display); font-size: 30px; font-weight: 500;
  color: var(--forest); letter-spacing: -1px; margin-bottom: 10px;
}
.analyzing-sub { font-size: 14px; color: var(--muted); font-weight: 400; line-height: 1.6; margin-bottom: 36px; }
.analyzing-steps { display: flex; flex-direction: column; gap: 12px; text-align: left; }
.analyzing-step {
  display: flex; align-items: center; gap: 12px;
  opacity: 0; animation: fadeUp 0.4s both;
  padding: 12px 16px; background: var(--surface);
  border-radius: 12px; border: 1px solid var(--border);
}
.analyzing-step:nth-child(1) { animation-delay: 0.1s; }
.analyzing-step:nth-child(2) { animation-delay: 0.4s; }
.analyzing-step:nth-child(3) { animation-delay: 0.7s; }
.analyzing-step:nth-child(4) { animation-delay: 1.0s; }
.analyzing-step-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--gold); flex-shrink: 0;
  animation: dotPulse 1.5s ease-in-out infinite;
}
.analyzing-step:nth-child(1) .analyzing-step-dot { animation-delay: 0s; }
.analyzing-step:nth-child(2) .analyzing-step-dot { animation-delay: 0.3s; }
.analyzing-step:nth-child(3) .analyzing-step-dot { animation-delay: 0.6s; }
.analyzing-step:nth-child(4) .analyzing-step-dot { animation-delay: 0.9s; }
@keyframes dotPulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.7); }
}
.analyzing-step-text { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
.analyzing-step-label { font-size: 11px; color: var(--muted); margin-top: 1px; font-weight: 400; }

/* ── DEBRIEF SCREEN ── */
.debrief-screen { max-width: 680px; margin: 0 auto; padding: 20px 24px 72px; animation: fadeIn 0.4s both; }
.debrief-top { text-align: center; margin-bottom: 28px; }
.debrief-eyebrow {
  font-size: 10px; font-weight: 600; letter-spacing: 3px;
  text-transform: uppercase; color: var(--gold); margin-bottom: 10px;
}
.debrief-headline {
  font-family: var(--ff-display); font-size: clamp(26px,4.5vw,38px);
  font-weight: 500; color: var(--forest); letter-spacing: -1.5px; line-height: 1.15;
}

/* ── CUE CARD ── */
.cue-card {
  background: var(--forest);
  background-image:
    radial-gradient(ellipse 80% 60% at 100% 0%, rgba(184,130,42,0.18) 0%, transparent 55%),
    radial-gradient(ellipse 50% 50% at 0% 100%, rgba(45,92,70,0.6) 0%, transparent 50%);
  border-radius: 22px; padding: 28px 28px 24px;
  margin-bottom: 16px; color: #F4F1EA;
  position: relative; overflow: hidden;
  box-shadow: 0 12px 48px rgba(28,58,46,0.2), 0 2px 8px rgba(28,58,46,0.12);
  animation: cardEntry 0.6s cubic-bezier(0.22,1,0.36,1) both;
}
@keyframes cardEntry {
  from { opacity: 0; transform: translateY(16px) scale(0.98); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
.cue-card::before {
  content: '';
  position: absolute; top: -1px; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(232,196,122,0.4), transparent);
}
/* Subtle dot-grid texture on card */
.cue-card::after {
  content: '';
  position: absolute; inset: 0;
  background-image: radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px);
  background-size: 20px 20px;
  pointer-events: none;
}
.card-inner { position: relative; z-index: 1; }

/* Score ring + header */
.cue-card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.cue-card-title { font-family: var(--ff-display); font-size: 20px; font-weight: 500; letter-spacing: -0.3px; opacity: 0.88; }
.cue-card-date { font-size: 11px; opacity: 0.4; margin-top: 4px; font-weight: 300; letter-spacing: 0.2px; }

/* Large centered score ring */
.score-ring-wrap {
  display: flex; flex-direction: column; align-items: center;
  margin: 4px 0 20px;
}
.score-ring-inner {
  position: relative; width: 108px; height: 108px;
}
.score-ring-svg { transform: rotate(-90deg); }
.score-ring-track { fill: none; stroke: rgba(255,255,255,0.1); }
.score-ring-fill {
  fill: none; stroke: var(--gold-light); stroke-linecap: round;
  transition: stroke-dasharray 1.4s cubic-bezier(0.22,1,0.36,1);
  filter: drop-shadow(0 0 6px rgba(232,196,122,0.4));
}
.score-ring-number {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.score-num-value {
  font-family: var(--ff-display); font-size: 32px; font-weight: 600;
  color: var(--gold-light); letter-spacing: -1.5px; line-height: 1;
}
.score-num-label {
  font-size: 9px; opacity: 0.45; letter-spacing: 1.5px;
  text-transform: uppercase; margin-top: 2px; font-weight: 500;
}

/* Coaching note — quote style */
.coaching-note {
  margin-bottom: 20px; padding: 0 4px;
  font-family: var(--ff-display); font-size: 16px; font-style: italic;
  line-height: 1.55; opacity: 0.85; color: #EFE8D8;
  position: relative; padding-left: 20px;
}
.coaching-note::before {
  content: '"';
  position: absolute; left: 0; top: -6px;
  font-size: 40px; color: var(--gold-light); opacity: 0.5;
  font-style: normal; line-height: 1;
}

/* Dimension scores */
.dimension-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.dimension { background: rgba(255,255,255,0.06); border-radius: 10px; padding: 12px 14px; }
.dimension-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
.dimension-name { font-size: 10px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; opacity: 0.55; }
.dimension-score { font-family: var(--ff-display); font-size: 19px; font-weight: 500; color: var(--gold-light); }
.dimension-bar { height: 5px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
.dimension-fill { height: 100%; border-radius: 3px; background: var(--gold-light); transition: width 1.1s cubic-bezier(0.22,1,0.36,1); }
.dimension-basis { font-size: 9px; opacity: 0.32; margin-top: 5px; letter-spacing: 0.3px; line-height: 1.3; font-weight: 400; }

/* Card footer */
.cue-card-footer {
  display: flex; align-items: center; justify-content: space-between;
  margin-top: 18px; padding-top: 16px;
  border-top: 1px solid rgba(255,255,255,0.09);
}
.cue-card-brand { font-family: var(--ff-display); font-size: 15px; font-weight: 500; opacity: 0.38; letter-spacing: -0.3px; }
.share-btn {
  display: flex; align-items: center; gap: 7px; padding: 8px 17px;
  background: rgba(255,255,255,0.09); border: 1px solid rgba(255,255,255,0.14);
  border-radius: 100px; color: rgba(244,241,234,0.8);
  font-family: var(--ff-body); font-size: 12px; font-weight: 500;
  cursor: pointer; transition: all 0.18s; letter-spacing: 0.2px;
}
.share-btn:hover:not(:disabled) { background: rgba(255,255,255,0.15); color: #F4F1EA; }
.share-btn:active:not(:disabled) { transform: scale(0.97); }
.share-btn:disabled { opacity: 0.45; cursor: wait; }

/* ── COACHING BLOCKS ── */
.coaching-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
@media (max-width: 540px) { .coaching-cards { grid-template-columns: 1fr; } }
.coaching-block {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r); padding: 20px 20px 18px;
  box-shadow: var(--shadow-sm);
  border-top: 3px solid transparent;
  transition: border-color 0.2s;
}
.coaching-block.full { grid-column: 1 / -1; }
.coaching-block.green  { border-top-color: var(--green); }
.coaching-block.amber  { border-top-color: var(--gold); }
.coaching-block.forest { border-top-color: var(--forest); }
.coaching-block-label {
  font-size: 10px; font-weight: 600; letter-spacing: 2px;
  text-transform: uppercase; margin-bottom: 10px;
}
.coaching-block-label.green  { color: var(--green); }
.coaching-block-label.amber  { color: var(--gold); }
.coaching-block-label.forest { color: var(--forest); }
.coaching-block-text { font-size: 14px; line-height: 1.75; color: var(--text-secondary); font-weight: 400; }

/* ── SIGNAL ANALYSIS ── */
.signals-section { margin-bottom: 14px; }
.signals-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.signals-title { font-size: 10px; font-weight: 600; letter-spacing: 2.5px; text-transform: uppercase; color: var(--muted); }
.signals-accuracy {
  font-size: 10px; color: var(--muted); padding: 3px 10px;
  border: 1px solid var(--border-strong); border-radius: 100px;
  font-family: var(--ff-body); font-weight: 400;
}
.signals-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
@media (max-width: 540px) { .signals-grid { grid-template-columns: 1fr; } }

.signal-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r); padding: 18px 18px 16px;
  box-shadow: var(--shadow-sm); overflow: hidden;
  position: relative;
}
.signal-card::before {
  content: ''; position: absolute;
  top: 0; left: 0; bottom: 0; width: 4px;
  border-radius: var(--r) 0 0 var(--r);
}
.signal-card.positive::before { background: var(--green); }
.signal-card.neutral::before  { background: var(--gold); }
.signal-card.concern::before  { background: var(--red); }

.signal-card-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding-left: 2px; }
.signal-name { font-size: 10px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); }
.signal-level {
  font-size: 10px; font-weight: 600; padding: 3px 10px;
  border-radius: 100px; letter-spacing: 0.5px;
}
.signal-level.positive { background: rgba(45,140,90,0.1); color: var(--green); }
.signal-level.neutral  { background: rgba(184,130,42,0.1); color: var(--gold); }
.signal-level.concern  { background: rgba(217,79,79,0.1); color: var(--red); }
.signal-finding { font-size: 13px; line-height: 1.7; color: var(--text-secondary); font-weight: 400; padding-left: 2px; }
.signal-basis { font-size: 10px; color: var(--muted); margin-top: 7px; font-style: italic; padding-left: 2px; }

.signals-synthesis {
  background: rgba(28,58,46,0.04); border: 1px solid var(--border);
  border-radius: var(--r); padding: 18px 20px;
  box-shadow: var(--shadow-sm);
}
.synthesis-label { font-size: 10px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--forest); margin-bottom: 8px; }
.synthesis-text { font-size: 14px; line-height: 1.75; color: var(--text-secondary); font-weight: 400; }
.signals-disclaimer { font-size: 11px; color: var(--muted); margin-top: 10px; line-height: 1.65; text-align: center; padding: 0 8px; font-style: italic; }

/* ── DEBRIEF ACTIONS ── */
.debrief-actions { display: flex; gap: 10px; margin-top: 6px; }
.again-btn {
  flex: 1; padding: 15px; background: var(--forest); color: #F4F1EA;
  border: none; border-radius: 14px; font-family: var(--ff-body);
  font-size: 15px; font-weight: 500; cursor: pointer;
  transition: background 0.2s, transform 0.15s, box-shadow 0.2s;
  box-shadow: var(--shadow);
}
.again-btn:hover { background: var(--forest-mid); transform: translateY(-1px); box-shadow: var(--shadow-lg); }
.again-btn:active { transform: scale(0.99); }
.home-btn {
  padding: 15px 22px; background: transparent; color: var(--muted);
  border: 1px solid var(--border-strong); border-radius: 14px;
  font-family: var(--ff-body); font-size: 14px; font-weight: 500;
  cursor: pointer; transition: all 0.18s;
}
.home-btn:hover { color: var(--forest); border-color: var(--forest); background: var(--forest-light); }
.home-btn:active { transform: scale(0.98); }

/* ── HISTORY DRAWER ── */
.history-overlay { position: fixed; inset: 0; background: rgba(28,58,46,0.35); z-index: 50; animation: fadeIn 0.2s; backdrop-filter: blur(2px); }
.history-drawer {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: var(--bg); border-radius: 22px 22px 0 0; z-index: 51;
  max-height: 72vh; overflow-y: auto;
  animation: slideUp 0.32s cubic-bezier(0.22,1,0.36,1);
  box-shadow: 0 -12px 48px rgba(28,58,46,0.14);
}
@keyframes slideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
.history-drawer::-webkit-scrollbar { width: 3px; }
.history-drawer::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }
.history-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 22px 26px 16px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg); z-index: 1;
}
.history-title { font-family: var(--ff-display); font-size: 22px; font-weight: 500; color: var(--forest); letter-spacing: -0.5px; }
.history-close {
  width: 30px; height: 30px; border-radius: 50%;
  border: 1px solid var(--border-strong); background: transparent;
  font-size: 14px; color: var(--muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all 0.18s;
}
.history-close:hover { color: var(--forest); border-color: var(--forest); background: var(--forest-light); }
.history-empty { padding: 48px 26px; text-align: center; color: var(--muted); font-size: 14px; font-weight: 400; line-height: 1.7; }
.history-item { padding: 16px 26px; border-bottom: 1px solid var(--border); transition: background 0.15s; }
.history-item:last-child { border-bottom: none; }
.history-item:hover { background: var(--forest-light); }
.history-item-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.history-item-date { font-size: 12px; color: var(--muted); font-weight: 400; }
.history-item-score { font-family: var(--ff-display); font-size: 24px; font-weight: 500; color: var(--forest); letter-spacing: -1px; }
.history-item-note { font-size: 13px; color: var(--text-secondary); font-weight: 400; line-height: 1.55; margin-bottom: 10px; font-style: italic; opacity: 0.8; }
.history-item-dims { display: flex; gap: 7px; flex-wrap: wrap; }
.history-dim { font-size: 11px; font-weight: 500; color: var(--forest); background: var(--forest-light); padding: 3px 10px; border-radius: 100px; }

/* ── ERROR + TOAST ── */
.error-bar {
  background: rgba(217,79,79,0.07); border: 1px solid rgba(217,79,79,0.18);
  border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #B03A3A;
  margin-bottom: 14px; font-weight: 400;
}
.toast {
  position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
  background: var(--forest); color: #F4F1EA;
  padding: 11px 22px; border-radius: 100px; font-size: 13px; font-weight: 500;
  box-shadow: var(--shadow-lg); z-index: 100;
  animation: toastIn 0.28s cubic-bezier(0.22,1,0.36,1);
  white-space: nowrap; max-width: 88vw; text-align: center;
}
.toast.warn-toast { background: #8A5E14; }
.toast.err-toast  { background: #9A2E2E; }
@keyframes toastIn {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
`;

// ─── SCORE RING ───────────────────────────────────────────────────────────────
const ScoreRing = ({ score }) => {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setCurrent(score), 250);
    return () => clearTimeout(t);
  }, [score]);
  const r = 40;
  const circ = 2 * Math.PI * r;
  const dash = (current / 100) * circ;
  return (
    <div className="score-ring-wrap">
      <div className="score-ring-inner">
        <svg className="score-ring-svg" width="108" height="108" viewBox="0 0 108 108">
          <circle className="score-ring-track" cx="54" cy="54" r={r} strokeWidth="5" />
          <circle
            className="score-ring-fill"
            cx="54" cy="54" r={r} strokeWidth="5"
            strokeDasharray={`${dash} ${circ}`}
          />
        </svg>
        <div className="score-ring-number">
          <div className="score-num-value">{current}</div>
          <div className="score-num-label">Score</div>
        </div>
      </div>
    </div>
  );
};

// ─── WAVE VIZ ─────────────────────────────────────────────────────────────────
const WaveViz = ({ isActive, level }) => {
  const BARS = 42;
  const [heights, setHeights] = useState(Array(BARS).fill(4));
  useEffect(() => {
    if (!isActive) { setHeights(Array(BARS).fill(4)); return; }
    const id = setInterval(() => {
      setHeights(prev => prev.map((_, i) => {
        const base = level * 46 + 6;
        return Math.max(4, Math.min(60,
          base + Math.sin(Date.now() / 180 + i * 0.55) * base * 0.35
               + (Math.random() - 0.5) * base * 0.6
        ));
      }));
    }, 70);
    return () => clearInterval(id);
  }, [isActive, level]);
  return (
    <div className="waveform">
      {heights.map((h, i) => (
        <div key={i} className="wbar" style={{
          height: h,
          opacity: isActive ? 0.42 + (h / 60) * 0.58 : 0.18,
        }} />
      ))}
    </div>
  );
};

// ─── SCORE BAR ────────────────────────────────────────────────────────────────
const ScoreBar = ({ score, delay = 0 }) => {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(score), 150 + delay); return () => clearTimeout(t); }, [score, delay]);
  return <div className="dimension-bar"><div className="dimension-fill" style={{ width: `${w}%` }} /></div>;
};

function tagTranscript(text) {
  return text.split(/(\s+)/).map((word, i) => {
    const w = word.toLowerCase().trim();
    if (FILLER_WORDS.includes(w)) return <span key={i} className="word-filler">{word}</span>;
    if (HEDGE_PHRASES.includes(w)) return <span key={i} className="word-hedge">{word}</span>;
    return word;
  });
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function CueApp() {
  const [view, setView] = useState("home");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [liveMetrics, setLiveMetrics] = useState({ words: 0, fillers: 0, wpm: 0, sensory: 0 });
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState(null);
  const [isSharing, setIsSharing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [dailyCount, setDailyCount] = useState(0);
  const [browserOk, setBrowserOk] = useState(true);

  const recogRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const rafRef = useRef(null);
  const timerRef = useRef(null);
  const startRef = useRef(null);
  const cueCardRef = useRef(null);
  const elapsedRef = useRef(0);

  useEffect(() => {
    setBrowserOk(!!(window.SpeechRecognition || window.webkitSpeechRecognition));
    setSessions(loadSessions());
    setDailyCount(getDailyCount());
  }, []);

  const showToast = useCallback((msg, type = "") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const stopAll = useCallback(() => {
    if (recogRef.current) { try { recogRef.current.stop(); } catch (e) {} }
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch (e) {} }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    setAudioLevel(0);
    setInterim("");
  }, []);

  const startRecording = useCallback(async () => {
    if (dailyCount >= DAILY_LIMIT) {
      showToast("Daily limit of 10 sessions reached. Resets at midnight.", "warn-toast");
      return;
    }
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        setAudioLevel(data.reduce((a, b) => a + b, 0) / data.length / 128);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const r = new SR();
      r.continuous = true;
      r.interimResults = true;
      r.lang = "en-US";
      recogRef.current = r;
      r.onresult = (e) => {
        let fin = "", int = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) fin += t + " ";
          else int += t;
        }
        if (fin) {
          setTranscript(p => {
            const next = p + fin;
            const words = next.toLowerCase().split(/\s+/).filter(Boolean);
            const fillers = words.filter(w => FILLER_WORDS.includes(w)).length;
            const sensory = words.filter(w => SENSORY.includes(w)).length;
            const secs = startRef.current ? (Date.now() - startRef.current) / 1000 : 1;
            setLiveMetrics({ words: words.length, fillers, wpm: Math.round((words.length / secs) * 60), sensory });
            return next;
          });
        }
        setInterim(int);
      };
      r.onerror = (e) => { if (e.error !== "no-speech") setError(`Mic error: ${e.error}`); };
      r.start();
      startRef.current = Date.now();
      elapsedRef.current = 0;
      setView("recording");
      timerRef.current = setInterval(() => { elapsedRef.current += 1; setElapsed(p => p + 1); }, 1000);
    } catch (err) {
      setError(err.message || "Microphone access denied. Check your browser settings.");
    }
  }, [dailyCount, showToast]);
  const finishAndAnalyze = useCallback(async () => {
    const full = (transcript + " " + interim).trim();
    const wordCount = full.split(/\s+/).filter(Boolean).length;
    const currentElapsed = elapsedRef.current;

    if (wordCount < MIN_WORDS || currentElapsed < MIN_SECONDS) {
      setError(`Keep going — ${Math.max(0, MIN_SECONDS - currentElapsed)}s more needed.`);
      return;
    }

    stopAll();
    setView("analyzing");

    const signals = computeSignals(full, currentElapsed);
    const signalSummary = `COMPUTED SIGNALS: Words: ${signals.total || 0} | ${fmt(currentElapsed)} | ${signals.wpm || 0} WPM`;

    try {
      const res = await fetch('/api/claude', {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript: full,
          signalSummary: signalSummary
        })
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "No error text");
        throw new Error(`HTTP ${res.status}: ${errorText}`);
      }

      const data = await res.json();
      const raw = (data.content || []).map(b => b.text || "").join("");
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

      const entry = { 
        ...parsed, 
        id: Date.now(), 
        date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), 
        duration: fmt(currentElapsed) 
      };

      setAnalysis(entry);
      const updated = [entry, ...sessions].slice(0, 20);
      setSessions(updated);
      saveSessions(updated);
      setDailyCount(incDailyCount());
      setView("debrief");

    } catch (err) {
      console.error("Analysis failed:", err);
      setError(`Analysis failed: ${err.message || "Unknown error - check console"}`);
      setView("recording");
    }
  }, [transcript, interim, stopAll, sessions]);
  const reset = useCallback(() => {
    stopAll();
    setTranscript(""); setInterim(""); setElapsed(0); elapsedRef.current = 0;
    setLiveMetrics({ words: 0, fillers: 0, wpm: 0, sensory: 0 });
    setAnalysis(null); setError("");
  }, [stopAll]);

  const readyToStop = liveMetrics.words >= MIN_WORDS && elapsed >= MIN_SECONDS;
  const minProgress = Math.min(100, (elapsed / MIN_SECONDS) * 100);

  return (
    <>
      <style>{css}</style>
      <div className="cue-app">

        {/* NAV */}
        <nav className="nav">
          <div className="wordmark" onClick={() => { reset(); setView("home"); }}>cue<span>.</span></div>
          <div className="nav-right">
            {view === "home" && sessions.length > 0 && (
              <button className="history-nav-btn" onClick={() => setShowHistory(true)}>
                History ({sessions.length})
              </button>
            )}
            <div className="nav-tag">
              {view === "home" && "Speech Intelligence"}
              {view === "recording" && "Session Active"}
              {view === "analyzing" && "Processing"}
              {view === "debrief" && "Your Debrief"}
            </div>
          </div>
        </nav>

        {error && view !== "analyzing" && (
          <div style={{ maxWidth: 680, margin: "0 auto", padding: "12px 24px 0" }}>
            <div className="error-bar">⚠ {error}</div>
          </div>
        )}

        {/* BROWSER WARNING */}
        {!browserOk && (
          <div className="screen browser-warn">
            <div className="browser-warn-icon">🌐</div>
            <div className="browser-warn-headline">Open in Chrome or Edge</div>
            <p className="browser-warn-sub">
              Cue uses your browser's speech recognition, which currently only works in Chrome and Edge. Safari and Firefox don't support it yet.<br /><br />
              Copy this URL and open it in Chrome.
            </p>
            <div className="browser-warn-badge">⚠ Speech recognition unavailable here</div>
          </div>
        )}

        {/* HOME */}
        {browserOk && view === "home" && (
          <div className="screen home">
            <div className="home-eyebrow">Speech Intelligence</div>
            <h1 className="home-headline">
              Hear yourself<br /><em>clearly.</em>
            </h1>
            <p className="home-sub">
              Record your pitch, presentation, or hard conversation. Cue applies research-validated analysis to show exactly how you come across.
            </p>
            <div className="home-cta-wrap">
              <button className="start-btn" onClick={startRecording} disabled={dailyCount >= DAILY_LIMIT}>
                <span className="start-btn-dot" />
                Start Recording
              </button>
              {dailyCount > 0 && dailyCount < DAILY_LIMIT && (
                <div className={`rate-note ${dailyCount >= DAILY_LIMIT - 2 ? "warn" : ""}`}>
                  {DAILY_LIMIT - dailyCount} session{DAILY_LIMIT - dailyCount !== 1 ? "s" : ""} remaining today
                </div>
              )}
              {dailyCount >= DAILY_LIMIT && <div className="rate-note blocked">Daily limit reached — resets at midnight</div>}
            </div>
            <div className="home-pillars">
              {["Conviction","Clarity","Composure","Connection"].map(p => (
                <div key={p} className="pillar-chip">{p}</div>
              ))}
            </div>
          </div>
        )}

        {/* RECORDING */}
        {view === "recording" && (
          <div className="screen record-screen">
            <div className="session-header">
              <div className="session-status">
                <div className="rec-dot" />
                <span className="session-label">Recording</span>
              </div>
              <div className="timer-display">{fmt(elapsed)}</div>
            </div>

            <div className="waveform-card">
              <WaveViz isActive={true} level={audioLevel} />
            </div>

            {!readyToStop && (
              <div className="min-guard">
                <span>⏳ {Math.max(0, MIN_SECONDS - elapsed)}s until ready</span>
                <div className="min-guard-bar">
                  <div className="min-guard-fill" style={{ width: `${minProgress}%` }} />
                </div>
              </div>
            )}

            <div className="transcript-card">
              <div className="transcript-label">Live Transcript</div>
              <div className="transcript-text">
                {!transcript && !interim
                  ? <span className="placeholder-text">Start speaking — your words will appear here…</span>
                  : <>{tagTranscript(transcript)}{interim && <span className="word-interim"> {interim}</span>}</>
                }
              </div>
            </div>

            <div className="metrics-row">
              {[
                { label: "Words", value: liveMetrics.words || "—", sub: null, warn: false },
                { label: "Pace", value: liveMetrics.wpm || "—", sub: "wpm", warn: false },
                { label: "Fillers", value: liveMetrics.fillers || "—", sub: "cognitive load", warn: liveMetrics.fillers > 8 },
                { label: "Sensory", value: liveMetrics.sensory || "—", sub: "detail words", highlight: liveMetrics.sensory >= 3 },
              ].map(m => (
                <div key={m.label} className="metric-chip">
                  <div className="metric-chip-label">{m.label}</div>
                  <div className="metric-chip-value" style={{
                    color: m.warn ? "var(--gold)" : m.highlight ? "var(--green)" : "var(--forest)"
                  }}>{m.value}</div>
                  {m.sub && <div className="metric-chip-sub">{m.sub}</div>}
                </div>
              ))}
            </div>

            <div className="record-controls">
              <button className="stop-btn" onClick={finishAndAnalyze} disabled={!readyToStop}>
                <span className="stop-square" />
                {readyToStop ? "Stop & Analyze" : `${Math.max(0, MIN_SECONDS - elapsed)}s until ready…`}
              </button>
              <button className="cancel-btn" onClick={() => { reset(); setView("home"); }}>Cancel</button>
            </div>
          </div>
        )}

        {/* ANALYZING */}
        {view === "analyzing" && (
          <div className="screen analyzing-screen">
            <div className="analyzing-wordmark">cue.</div>
            <div className="analyzing-headline">Analyzing your session</div>
            <p className="analyzing-sub">Applying four validated speech frameworks to your transcript.</p>
            <div className="analyzing-steps">
              {[
                { name: "Narrative Structure", label: "CBCA — Köhnken & Steller" },
                { name: "Sensory Grounding", label: "Reality Monitoring — Johnson & Raye" },
                { name: "Verbal Immediacy",  label: "LIWC — Pennebaker et al." },
                { name: "Cognitive Load",    label: "Vrij et al. 2017" },
              ].map(s => (
                <div key={s.name} className="analyzing-step">
                  <div className="analyzing-step-dot" />
                  <div>
                    <div className="analyzing-step-text">{s.name}</div>
                    <div className="analyzing-step-label">{s.label}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DEBRIEF */}
        {view === "debrief" && analysis && (
          <div className="screen debrief-screen">
            <div className="debrief-top">
              <div className="debrief-eyebrow">Session Debrief</div>
              <h2 className="debrief-headline">Here's how you came across.</h2>
            </div>

            {/* Cue Card */}
            <div className="cue-card" ref={cueCardRef}>
              <div className="card-inner">
                <div className="cue-card-header">
                  <div>
                    <div className="cue-card-title">Your Cue Card</div>
                    <div className="cue-card-date">{analysis.date} · {analysis.duration}</div>
                  </div>
                </div>

                <ScoreRing score={analysis.overallScore} />

                <div className="coaching-note">{analysis.coachingNote}</div>

                <div className="dimension-grid">
                  {[
                    { name: "Conviction", key: "conviction", basis: "Pennebaker LIWC" },
                    { name: "Clarity",    key: "clarity",    basis: "CBCA" },
                    { name: "Composure",  key: "composure",  basis: "Cognitive Load" },
                    { name: "Connection", key: "connection", basis: "Reality Monitoring" },
                  ].map((d, i) => {
                    const score = analysis[d.key] ?? 0;
                    return (
                      <div key={d.name} className="dimension">
                        <div className="dimension-top">
                          <div className="dimension-name">{d.name}</div>
                          <div className="dimension-score">{score}</div>
                        </div>
                        <ScoreBar score={score} delay={i * 140} />
                        <div className="dimension-basis">{d.basis}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="cue-card-footer">
                  <div className="cue-card-brand">cue.</div>
                  <button className="share-btn" onClick={handleShare} disabled={isSharing}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                    </svg>
                    {isSharing ? "Capturing…" : "Share My Score"}
                  </button>
                </div>
              </div>
            </div>

            {/* Coaching Notes */}
            <div className="coaching-cards">
              <div className="coaching-block green">
                <div className="coaching-block-label green">What Worked</div>
                <div className="coaching-block-text">{analysis.whatWorked}</div>
              </div>
              <div className="coaching-block amber">
                <div className="coaching-block-label amber">What to Fix</div>
                <div className="coaching-block-text">{analysis.whatToFix}</div>
              </div>
              <div className="coaching-block forest full">
                <div className="coaching-block-label forest">Moment to Watch</div>
                <div className="coaching-block-text">{analysis.momentToWatch}</div>
              </div>
            </div>

            {/* Signal Analysis */}
            {analysis.signals && (
              <div className="signals-section">
                <div className="signals-header">
                  <div className="signals-title">Signal Analysis</div>
                  <div className="signals-accuracy">~67–70% accuracy</div>
                </div>
                <div className="signals-grid">
                  {[
                    { key: "narrativeDetail",  label: "Narrative Detail",  basis: "CBCA" },
                    { key: "sensoryGrounding", label: "Sensory Grounding", basis: "Reality Monitoring" },
                    { key: "verbalImmediacy",  label: "Verbal Immediacy",  basis: "Pennebaker LIWC" },
                    { key: "cognitiveLoad",    label: "Cognitive Load",    basis: "Vrij et al." },
                  ].map(s => {
                    const sig = analysis.signals[s.key];
                    if (!sig) return null;
                    const level = sig.level || "";
                    const cls = ["RICH","GROUNDED","DIRECT","FLUID"].includes(level) ? "positive"
                              : ["MODERATE","MIXED","NEUTRAL"].includes(level) ? "neutral" : "concern";
                    return (
                      <div key={s.key} className={`signal-card ${cls}`}>
                        <div className="signal-card-top">
                          <div className="signal-name">{s.label}</div>
                          <div className={`signal-level ${cls}`}>{level}</div>
                        </div>
                        <div className="signal-finding">{sig.finding}</div>
                        <div className="signal-basis">{s.basis}</div>
                      </div>
                    );
                  })}
                </div>
                {analysis.signals.synthesis && (
                  <div className="signals-synthesis">
                    <div className="synthesis-label">Overall Read</div>
                    <div className="synthesis-text">{analysis.signals.synthesis}</div>
                  </div>
                )}
                <div className="signals-disclaimer">
                  Probabilistic patterns, not verdicts. Validated frameworks achieve ~67–70% accuracy in research settings.
                </div>
              </div>
            )}

            <div className="debrief-actions">
              <button className="again-btn" onClick={() => { reset(); startRecording(); }}>Record Again</button>
              <button className="home-btn" onClick={() => { reset(); setView("home"); }}>Home</button>
            </div>
          </div>
        )}

        {/* HISTORY */}
        {showHistory && (
          <>
            <div className="history-overlay" onClick={() => setShowHistory(false)} />
            <div className="history-drawer">
              <div className="history-header">
                <div className="history-title">Past Sessions</div>
                <button className="history-close" onClick={() => setShowHistory(false)}>✕</button>
              </div>
              {sessions.length === 0
                ? <div className="history-empty">No sessions yet.<br />Your debriefs will appear here after your first recording.</div>
                : sessions.map(s => (
                  <div key={s.id} className="history-item">
                    <div className="history-item-top">
                      <div className="history-item-date">{s.date} · {s.duration}</div>
                      <div className="history-item-score">{s.overallScore}</div>
                    </div>
                    <div className="history-item-note">"{s.coachingNote}"</div>
                    <div className="history-item-dims">
                      {DIMENSIONS.map(d => <div key={d} className="history-dim">{d[0]} {s[d.toLowerCase()]}</div>)}
                    </div>
                  </div>
                ))
              }
            </div>
          </>
        )}

        {toast && <div className={`toast ${toast.type}`}>{toast.msg}</div>}
      </div>
    </>
  );
}