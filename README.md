# ⚽ Universal xG Calculator

A browser-based expected goals (xG) calculator with automated predictions, results tracking, and accuracy monitoring — powered by **Firebase** and **API-Football**.

## Features

- 🎯 **Automated predictions** for 30+ leagues (updated daily at 02:00 UTC)
- 📊 **Results tracking** for the last 3 days (updated daily at 06:00 UTC)
- 🧾 **Accuracy tracker** with Brier score and log loss per league
- 📐 **Dixon-Coles / Poisson model** with configurable ρ (rho)
- 🔐 **Secure API key storage** via Firebase Cloud Functions secrets
- ⚡ **Real-time updates** through Firestore listeners
- 🧮 **Manual CSV workflow** for custom leagues

## Architecture

```
API-Football → Cloud Functions → Firestore → Browser
```

- **Cloud Functions** run on schedules, fetch data, fit models, compute predictions, grade results.
- **Firestore** stores predictions, results, accuracy metrics.
- **Firebase Hosting** serves the static frontend.
- **API key** is stored as a Cloud Functions secret, never exposed to the browser.

## Setup

### Prerequisites

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- API-Football account: [dashboard.api-football.com](https://dashboard.api-football.com/register)

### Installation

1. **Clone the repo**
   ```bash
   git clone https://github.com/YOUR-USERNAME/xg-calculator.git
   cd xg-calculator
   ```

2. **Install function dependencies**
   ```bash
   cd functions
   npm install
   cd ..
   ```

3. **Login to Firebase**
   ```bash
   firebase login
   ```

4. **Connect to your project**
   ```bash
   firebase use --add
   # Select your project and alias it as "default"
   ```

5. **Store your API-Football key as a secret**
   ```bash
   firebase functions:secrets:set API_FOOTBALL_KEY
   # Paste your key when prompted
   ```

6. **Update `public/firebase-config.js`**
   Copy the config from Firebase Console → Project Settings → Your apps → Web app.

7. **Deploy**
   ```bash
   firebase deploy
   ```

8. **Trigger the first model fit**
   - Firebase Console → Functions → `weeklyModelFit` → "Run now"
   - Wait ~1 minute, then check Firestore for `models/current`

### GitHub Pages Alternative

If you don't want to use Firebase Hosting, you can deploy the `public/` folder to GitHub Pages. However, **you must** still use Cloud Functions for the scheduled jobs and API key security.

## Scheduling

| Function | Schedule | Purpose |
|---|---|---|
| `weeklyModelFit` | Mondays 01:00 UTC | Fit Poisson models for all leagues |
| `dailyFixtures` | Daily 02:00 UTC | Fetch fixtures, predict, grade |

## API Usage

Free tier: 100 requests/day. This system uses ~14 requests/day (7 for model fit weekly + 7 daily window fetch).

## License

MIT