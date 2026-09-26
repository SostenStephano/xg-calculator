// ============================================================
// Firebase Web SDK configuration for project: xg-calculator
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA37Or63Mcejb46z5Hv8RZm30JtHsZ9AtE",
  authDomain: "xg-calculator.firebaseapp.com",
  projectId: "xg-calculator",
  storageBucket: "xg-calculator.firebasestorage.app",
  messagingSenderId: "686064983183",
  appId: "1:686064983183:web:12981d6129a54ffb37e4fa",
  measurementId: "G-V792DBGL24"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db, collection, doc, query, where, orderBy, limit, onSnapshot };