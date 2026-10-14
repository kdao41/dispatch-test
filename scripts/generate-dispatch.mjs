#!/usr/bin/env node
/* ============================================================
   Weekly dispatch generator  (runs on GitHub Actions)
   - Pulls each league live from Sleeper (GitHub runners CAN reach it)
   - Computes the real numbers (records, all-play, luck, highs/lows, top players)
   - Asks the Claude API to write the dispatch in the Almanac voice
   - Writes dispatches/<leagueId>/wk<week>.html  (the page loads these)
   Requires env:  ANTHROPIC_API_KEY
   Config:        dispatch.config.json  { "model": "...", "leagues": [{id,name,mine?}] }
   ============================================================ */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const API = "https://api.sleeper.app/v1";
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

// ---- config ----
const cfg = JSON.parse(await readFile(new URL("../dispatch.config.json", import.meta.url), "utf8"));
const MODEL = cfg.model || "claude-sonnet-5-5";
const LEAGUES = cfg.leagues || [];
const ONLY = process.env.ONLY_LEAGUE || ""; // optional: run just one id (manual runs)

const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + " -> " + r.status); return r.json(); };
const n1 = (x) => Math.round(x * 10) / 10;

// ---- pull one league ----
async function pull(id) {
  const lg = await j(`${API}/league/${id}`);
  const [users, rosters] = await Promise.all([j(`${API}/league/${id}/users`), j(`${API}/league/${id}/rosters`)]);
  const uname = {}; users.forEach(u => uname[u.user_id] = u.display_name || u.username);
  const rName = {}; rosters.forEach(r => rName[r.roster_id] = (r.owner_id && uname[r.owner_id]) || ("Team " + r.roster_id));
  const pwk = (lg.settings && lg.settings.playoff_week_start) || 15;
  const weeks = {}; let upcoming = null, upWeek = null;
  for (let w = 1; w < pwk; w++) {
    let m; try { m = await j(`${API}/league/${id}/matchups/${w}`); } catch (e) { break; }
    if (m && m.some(x => x.points > 0)) weeks[w] = m; else { upcoming = m; upWeek = w; break; }
  }
  return { lg, rName, rosters, weeks, upcoming, upWeek, pwk };
}

// ---- compute standings / all-play / luck / games, like the page does ----
function compute(C) {
  const { rName, weeks } = C;
  const ids = Object.keys(rName);
  const S = {}; ids.forEach(r => S[r] = { name: rName[r], w: 0, l: 0, t: 0, pf: 0, pa: 0, aw: 0, al: 0, scores: [] });
  const games = [];
  const completed = Object.keys(weeks).map(Number).sort((a, b) => a - b);
  for (const w of completed) {
    const m = weeks[w];
    const sc = m.map(x => ({ r: x.roster_id, p: x.points || 0 }));
    sc.forEach(a => sc.forEach(b => { if (a.r !== b.r) { if (a.p > b.p) S[a.r].aw++; else if (a.p < b.p) S[a.r].al++; } }));
    m.forEach(x => S[x.roster_id].scores.push({ wk: w, p: x.points || 0 }));
    const bm = {}; m.forEach(x => { (bm[x.matchup_id] = bm[x.matchup_id] || []).push(x); });
    for (const k in bm) {
      const [a, b] = bm[k]; if (!a || !b) continue;
      const ap = a.points || 0, bp = b.points || 0;
      S[a.roster_id].pf += ap; S[a.roster_id].pa += bp; S[b.roster_id].pf += bp; S[b.roster_id].pa += ap;
      if (ap > bp) { S[a.roster_id].w++; S[b.roster_id].l++; } else if (bp > ap) { S[b.roster_id].w++; S[a.roster_id].l++; } else { S[a.roster_id].t++; S[b.roster_id].t++; }
      const hi = ap >= bp ? a : b, lo = ap >= bp ? b : a;
      games.push({ wk: w, hi: rName[hi.roster_id], lo: rName[lo.roster_id], hip: Math.max(ap, bp), lop: Math.min(ap, bp) });
    }
  }
  const T = ids.map(r => { const s = S[r]; const g = s.w + s.l + s.t; const ap = s.aw + s.al;
    return { ...s, g, winpct: g ? s.w / g : 0, appct: ap ? s.aw / ap : 0, pfg: completed.length ? s.pf / completed.length : 0 }; });
  return { T, games, completed };
}

// ---- top individual performances for the latest week (optional flavor) ----
async function topPerformers(C, week, PLAYERS) {
  const m = C.weeks[week]; if (!m) return [];
  const out = [];
  for (const x of m) {
    const st = new Set(x.starters || []); const pp = x.players_points || {};
    for (const pid of st) {
      const pts = pp[pid]; if (pts == null) continue;
      const p = PLAYERS[pid]; const nm = p ? (p.full_name || ((p.first_name || "") + " " + (p.last_name || "")).trim()) : pid;
      const pos = p ? p.position : "";
      out.push({ team: C.rName[x.roster_id], player: nm, pos, pts });
    }
  }
  return out.sort((a, b) => b.pts - a.pts).slice(0, 5);
}

// ---- assemble the data brief the model writes from ----
function brief(C, cmp, week, tops) {
  const T = cmp.T;
  const byRec = [...T].sort((a, b) => (b.w - a.w) || (b.pf - a.pf));
  const byLuck = [...T].sort((a, b) => (b.winpct - b.appct) - (a.winpct - a.appct));
  const byPower = [...T].sort((a, b) => (b.appct - a.appct) || (b.pf - a.pf));
  const g = cmp.games;
  const hi = [...g].sort((a, b) => b.hip - a.hip)[0];
  const blow = [...g].sort((a, b) => (b.hip - b.lop) - (a.hip - a.lop))[0];
  const close = [...g].sort((a, b) => (a.hip - a.lop) - (b.hip - b.lop))[0];
  const mpl = [...g].sort((a, b) => b.lop - a.lop)[0];
  const rec = (t) => `${t.w}-${t.l}${t.t ? "-" + t.t : ""}`;
  const lines = [];
  lines.push(`LEAGUE: ${C.lg.name} | Season ${C.lg.season} | ${C.lg.total_rosters} teams | through Week ${week}`);
  lines.push(`\nSTANDINGS (record, PF, PA, all-play W-L, luck=winpct-allplaypct):`);
  byRec.forEach((t, i) => lines.push(`${i + 1}. ${t.name}: ${rec(t)}, PF ${n1(t.pf)}, PA ${n1(t.pa)}, all-play ${t.aw}-${t.al}, luck ${n1((t.winpct - t.appct) * 100)}%`));
  lines.push(`\nPOWER (by all-play, true strength): ${byPower.map((t, i) => `${i + 1}.${t.name}`).join("  ")}`);
  const lucky = byLuck[0], robbed = byLuck[byLuck.length - 1];
  lines.push(`\nLUCKIEST: ${lucky.name} (${rec(lucky)} but all-play ${lucky.aw}-${lucky.al})`);
  lines.push(`MOST ROBBED: ${robbed.name} (${rec(robbed)} but all-play ${robbed.aw}-${robbed.al})`);
  if (hi) lines.push(`\nHIGH SCORE: ${hi.hi} ${n1(hi.hip)} (Wk ${hi.wk})`);
  if (blow) lines.push(`BIGGEST BLOWOUT: ${blow.hi} ${n1(blow.hip)} over ${blow.lo} ${n1(blow.lop)} (Wk ${blow.wk})`);
  if (close) lines.push(`CLOSEST GAME: ${close.hi} ${n1(close.hip)} vs ${close.lo} ${n1(close.lop)} (Wk ${close.wk})`);
  if (mpl) lines.push(`MOST POINTS IN A LOSS: ${mpl.lo} ${n1(mpl.lop)}, lost to ${mpl.hi} ${n1(mpl.hip)} (Wk ${mpl.wk})`);
  if (tops && tops.length) lines.push(`\nTOP PERFORMERS (this week): ${tops.map(t => `${t.player} (${t.pos}, ${t.team}) ${n1(t.pts)}`).join(" · ")}`);
  // upcoming
  if (C.upcoming && C.upcoming.length) {
    const bm = {}; C.upcoming.forEach(x => { (bm[x.matchup_id] = bm[x.matchup_id] || []).push(x); });
    const pairs = []; for (const k in bm) { const [a, b] = bm[k]; if (a && b) pairs.push(`${C.rName[a.roster_id]} vs ${C.rName[b.roster_id]}`); }
    if (pairs.length) lines.push(`\nUPCOMING Week ${C.upWeek}: ${pairs.join(" | ")}`);
  }
  return lines.join("\n");
}

const SYSTEM = `You are the writer of "The League Almanac," a weekly fantasy football dispatch read by the members of a private league. Write the lead story for this week in a sharp, funny, knowledgeable newsletter voice — think The Ringer meets a group chat that has known each other for years. Rules:
- Return ONLY an HTML fragment: a handful of <p> paragraphs, optionally one or two <h3> subheads and <b> for emphasis. No <html>, <head>, <style>, no markdown, no code fences.
- 4 to 7 short paragraphs. Open with the single biggest storyline of the week, not a generic "through week X" preamble.
- Use the REAL names and REAL numbers from the data. Never invent players, scores, injuries, or trades you weren't given. If you reference a real NFL injury or storyline, keep it to well-known facts; when unsure, stay on the fantasy numbers you were given.
- Call out the luck gap (record vs all-play) where it tells a story. Name a riser, a faller, and the team in the cellar.
- Light, clever trash talk aimed at the managers is welcome. Never cruel, never about anyone's personal life, race, or anything outside fantasy football.
- End by looking ahead to the upcoming week's marquee matchup if one is provided.
Output the HTML fragment and nothing else.`;

async function writeDispatch(dataBrief) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1600,
      system: SYSTEM,
      messages: [{ role: "user", content: "Write this week's dispatch from this data:\n\n" + dataBrief }]
    })
  });
  if (!res.ok) throw new Error("Anthropic API " + res.status + ": " + (await res.text()).slice(0, 300));
  const d = await res.json();
  let html = (d.content || []).map(c => c.text || "").join("").trim();
  html = html.replace(/^```html\s*/i, "").replace(/```$/,"").trim(); // strip fences if any slipped in
  return html;
}

// ---- main ----
let wrote = 0;
for (const L of LEAGUES) {
  if (ONLY && L.id !== ONLY) continue;
  try {
    const C = await pull(L.id);
    const cmp = compute(C);
    if (!cmp.completed.length) { console.log(`${L.name}: no completed weeks yet, skipping.`); continue; }
    const week = Math.max(...cmp.completed);
    const outPath = new URL(`../dispatches/${L.id}/wk${week}.html`, import.meta.url);
    if (existsSync(outPath) && !process.env.FORCE) { console.log(`${L.name}: wk${week} already exists, skipping (set FORCE=1 to overwrite).`); continue; }
    let PLAYERS = {}; try { PLAYERS = await j(`${API}/players/nfl`); } catch (e) { /* flavor only */ }
    const tops = await topPerformers(C, week, PLAYERS);
    const html = await writeDispatch(brief(C, cmp, week, tops));
    if (!html) { console.log(`${L.name}: model returned empty, skipping.`); continue; }
    await mkdir(new URL(`../dispatches/${L.id}/`, import.meta.url), { recursive: true });
    await writeFile(outPath, html + "\n", "utf8");
    console.log(`${L.name}: wrote dispatches/${L.id}/wk${week}.html (${html.length} chars)`);
    wrote++;
  } catch (e) {
    console.error(`${L.name}: FAILED — ${e.message}`);
  }
}
console.log(`\nDone. Wrote ${wrote} dispatch file(s).`);
// Signal to the workflow whether anything changed.
if (process.env.GITHUB_OUTPUT) {
  await writeFile(process.env.GITHUB_OUTPUT, `wrote=${wrote}\n`, { flag: "a" });
}
