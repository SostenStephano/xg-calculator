// ============================================================
// Shared Firestore data store — ONE listener per collection,
// shared across all pages. Replaces per-page onSnapshot calls.
// ============================================================

import {
  db, collection, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";

// ---------- Predictions ----------
let predictionsCache = [];
let predictionsLoaded = false;
let predictionsStarted = false;
const predictionSubs = new Set();

function startPredictionsListener() {
  if (predictionsStarted) return;
  predictionsStarted = true;

  const q = query(
    collection(db, "predictions"),
    orderBy("kickoff", "asc"),
    limit(250)          // enough for ~12 leagues × 15 matches + custom
  );

  onSnapshot(q, snap => {
    predictionsCache = [];
    snap.forEach(d => predictionsCache.push({ id: d.id, ...d.data() }));
    predictionsLoaded = true;
    predictionSubs.forEach(fn => {
      try { fn(predictionsCache); } catch (e) { console.error("pred sub error", e); }
    });
  }, err => {
    console.error("Predictions listener error:", err.message);
  });
}

export function subscribePredictions(fn) {
  startPredictionsListener();
  predictionSubs.add(fn);
  if (predictionsLoaded) fn(predictionsCache);
  return () => predictionSubs.delete(fn);
}

export function getPredictions() {
  return predictionsCache;
}

// ---------- Results ----------
let resultsCache = [];
let resultsLoaded = false;
let resultsStarted = false;
const resultSubs = new Set();

function startResultsListener() {
  if (resultsStarted) return;
  resultsStarted = true;

  const q = query(
    collection(db, "results"),
    orderBy("kickoff", "desc"),
    limit(100)          // last ~3 days of major leagues
  );

  onSnapshot(q, snap => {
    resultsCache = [];
    snap.forEach(d => resultsCache.push({ id: d.id, ...d.data() }));
    resultsLoaded = true;
    resultSubs.forEach(fn => {
      try { fn(resultsCache); } catch (e) { console.error("res sub error", e); }
    });
  }, err => {
    console.error("Results listener error:", err.message);
  });
}

export function subscribeResults(fn) {
  startResultsListener();
  resultSubs.add(fn);
  if (resultsLoaded) fn(resultsCache);
  return () => resultSubs.delete(fn);
}

export function getResults() {
  return resultsCache;
}
