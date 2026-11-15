# Season switch

Hustle Builder leads with one season at a time. The switch is a single line in `config/season.js`:

```js
const SEASON = "fall";
```

Change that line to `"snow"` when snow arrives, or back to `"fall"` for yard cleanup. Then merge to main. Do not add a Vercel env var. The page reads this file when it loads.

`fall` puts Yard cleanup first in the job picker and makes it the default for a new draft that has not been filled in. Lawn and pet care come next, then snow and both. The home page, the welcome sample, and `/parents` lead with yard cleanup and leaves.

`snow` puts snow shoveling first and makes it the default for a new draft. The welcome sample and `/parents` lead with snow shoveling.

A draft already saved on a phone, and a page already published, stay as they are. The lawn-first wording from before this switch is stored in the same file as `LAWN_SNAPSHOT`.
