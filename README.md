# To Do

A simple to-do app for iPhone that you add to your home screen, with reminder notifications.

- **App:** https://akinborodehayzed-creator.github.io/todo/ (the `docs/` folder, hosted on GitHub Pages)
- **Reminder server:** `server/`, a free Cloudflare Worker that sends each push notification when its task is due

## Install on iPhone (iOS 16.4 or newer)

1. Open the app link in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **To Do** from your home screen and tap **Turn on** → **Allow**.
4. Tap **Send a test notification** at the bottom to check it works.

Tasks are saved on your phone. When you add a task with a reminder time, the app sends that one reminder to the server, which pushes the notification at the right time, even if the app is closed.

## Deploy the reminder server (one time)

```bash
cd server
npm install
npx wrangler login                      # opens the browser to sign in to Cloudflare (free account)
npx wrangler secret put VAPID_PRIVATE_KEY < .vapid-private.json
npx wrangler deploy
```

`deploy` prints the server address, like `https://todo-reminders.<you>.workers.dev`. Put it in `docs/config.js` as `serverUrl`, then commit and push.

`server/.vapid-private.json` is the private key that signs notifications. It is in `.gitignore`; keep it off GitHub. Its public half is `vapidPublicKey` in `docs/config.js`.

## Run locally

```bash
python3 -m http.server 8080 --directory docs   # the app
cd server && npx wrangler dev                    # the server (reads .dev.vars)
```
