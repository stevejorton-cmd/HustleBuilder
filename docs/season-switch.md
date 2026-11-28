# Season switch

Hustle Builder follows the calendar unless a season is forced. The line in `config/season.js` is:

```js
const SEASON = "auto";
```

`auto` uses the date on the device:

- September, October, and November are fall. Fall and winter job ideas lead, and snow shoveling is on the main picker.
- December, January, and February are winter (the same pack as `"snow"`). Snow shoveling is the default for a new draft.
- March through August use the summer ideas. Lawn care leads. Snow shoveling, yard cleanup, and the other jobs stay on the picker.

Set that line to `"fall"`, `"winter"` (or `"snow"`), or `"summer"` to force a season, then merge to main. Do not add a Vercel env var. The page reads this file when it loads.

Saved work and app settings can remember `hb-season-mode` on one device (`auto`, `fall`, `winter`, or `summer`). That does not change the draft save key. A draft already saved on a phone, and a page already published, stay as they are. The lawn-first wording from before the first season switch is stored in the same file as `LAWN_SNAPSHOT`.
