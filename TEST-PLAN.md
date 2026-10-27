# Real-world test plan for Hustle Builder

Everything so far was tested in a desktop browser on phone-size screens. This plan covers what a computer could not check. It takes about two class periods with 2 or 3 student volunteers and a parent or teacher helper.

## Before you start
- [ ] Check your district's rules on student-run websites, student data, and where the site may be hosted. Get an OK in writing.
- [ ] Choose 2 or 3 volunteers (ideally one lawn, one snow, one both) and tell their parents what the app does. The app keeps data on the device only.
- [ ] Upload the current `index.html` to GitHub Pages (or another host) and write down the link.

## 1. Phones and tablets (10 minutes each device)
Test on at least one iPhone, one Android phone, and one school Chromebook.
- [ ] The app opens from the link and fits the screen with no sideways scrolling.
- [ ] Build steps 1 to 8: type with the on-screen keyboard, tap every chip, and use the slider with a finger.
- [ ] Add a job from "Add more jobs". Move a job with the arrows.
- [ ] Schedule: turn days on and off, change hours with the time pickers.
- [ ] Add one before and one after photo from the phone camera or photo library (lawn or driveway only).
- [ ] Download the website file. Note where it saved and how easy it was to find.
- [ ] Poster Studio: pick a layout, change color, words, and sticker. Save a PDF and an image.
- [ ] Save then close the browser, reopen the link. Is everything still there?

## 2. The customer website (use a different phone than the one that built it)
- [ ] The live link opens on cellular data, not just school Wi-Fi.
- [ ] The picture, fonts, and rates show correctly. Night look and Day look both read well in sunlight.
- [ ] Book a day: pick a date, pick a time, fill the form, tap Text my request. Does the Messages app open with the full request, including size, how often, and time?
- [ ] Try the Email button too. Try with no phone number set (what shows up?).
- [ ] The Venmo button opens Venmo.
- [ ] Before and after slider works with a thumb.

## 2b. Booking alerts (needs a parent and a personal Google account)
- [ ] Follow the setup in the app (Go live, Get booking alerts). Time how long it takes and note every place the parent got stuck.
- [ ] Press Run on `setup`. Did Google show the "not verified" warning, and did the parent get the "ready" email?
- [ ] Deploy as a Web app (Execute as Me, access Anyone). Paste the URL and press Send a test booking. Did the parent get a TEST email and see a TEST event on the calendar?
- [ ] Download the website again and open it on a different phone. Pick a day, fill the form (with a phone number), and tap Send my request. Did the email arrive within a minute? Is there a HOLD on the calendar?
- [ ] Book the same time again from a second phone. Is it refused as taken, and is that time hidden afterward?
- [ ] Add the Hustle Jobs calendar to an iPhone, to Outlook, and to Skylight (if you have one). Does the HOLD show up, and how long does it take?
- [ ] Add a "Not available" all-day event to the Hustle Jobs calendar. Does that day turn grey on the website?
- [ ] Turn off Wi-Fi on the customer phone and try to send. Does the page offer Text it instead?
- [ ] A school Google account: does it block step 5?
- [ ] Waitlist: fill a whole day (add an all-day event to the Hustle Jobs calendar), reload the website, tap the full day, and tap Join the waitlist. Did both parents get the email?
- [ ] Photo: book with a photo of a yard from a phone camera. Did a second email arrive with the photo attached? Did it arrive in the same thread or a separate one, and was it clear which booking it belongs to?
- [ ] Weekly summary: wait for Sunday at 6 PM (or change the trigger time in the script's Triggers page) and check the email.
- [ ] Backup parent: does the second parent get every alert and the weekly summary? Does the website's Text button for them open the right number?
- [ ] Upgrading: set up version 1, then paste the new code and deploy a new version. Does everything still work?

## 3. Printing
- [ ] Save the flyer PDF, then print it from a phone (AirPrint or Android print) and from a computer.
- [ ] Print one of each: flyer, door hanger, business cards, Neighbor card, one poster. Use letter paper at 100%.
- [ ] Scan the QR code from the paper with a different phone from about 2 feet away. Does it open the site?
- [ ] Ink saver (black and white) prints well on a basic printer?

## 4. Boss mode (a real week)
- [ ] Schedule two jobs. Tap Confirm by text. Does the message read well to a customer?
- [ ] On my way, Start job, Finish job with the done message and photo reminder.
- [ ] Ask for a review and Ask for a referral.
- [ ] Log a cost. Check profit and real hourly rate make sense.

## 5. Class mode
- [ ] Each student makes a progress code and sends it to the teacher by text or file.
- [ ] Teacher pastes the codes. Totals and the scorecard look right.

## 6. Safety and policy check with a parent
- [ ] The site shows only a first name, a town, and a parent's phone or email. No last name, street address, school, or face.
- [ ] A parent can read the whole site and says yes before it goes public.
- [ ] Students only use equipment their parents approve for their age (child labor rules can limit power equipment).
- [ ] No flyers go inside mailboxes.

## What to write down
For every problem: device, browser, what the student tapped, what happened, and a screenshot. Send the list back and each item becomes a fix.

## Pass line
The pilot passes when each volunteer, with only a parent's help, gets a working website link, a printed flyer whose QR code opens the site, and one booking request received on a parent's phone.
