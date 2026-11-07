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

## Features

- **Tasks:** type plain English (`Gym tomorrow 6pm every mon and thu #health !1 @fitness`), Today / Upcoming / Inbox / lists views, overdue with "Move to today", steps, notes, priorities, tags
- **Reminders:** repeating (daily, weekdays, custom, "after done"), snooze, "remind again" nagging until done, tapping a notification opens the task
- **Focus:** Pomodoro timer and stopwatch with stats; notifies when a session ends
- **Habits:** daily or chosen days, goals per day, streaks, monthly calendar, reminders
- **Steps:** daily goal ring, streaks, 7-day chart; today's count comes from Apple Health through a Shortcut (Steps → Apple Health in the app has the setup), plus treadmill sessions estimated from time and speed or distance
- **AI coach** (Coach button at the top): add your own Google Gemini key; it reads your open, finished and pushed-back tasks and the reason you gave for each, gives a Gentle / Direct / Brutal verdict, chats, and sends a morning message. The key stays on the phone.
- **Voice tasks** (mic next to Add): say what you need to do; Gemini turns it into tasks with dates, lists, priority and steps, and asks for a deadline if you didn't give one
- **Countdowns:** days until / days since, yearly birthdays and anniversaries, reminders on the day, a day or a week before
- **Also:** undo, backup and restore (Settings), tick sound, dark mode

Parser tests: `node tests/parse.test.js`

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
