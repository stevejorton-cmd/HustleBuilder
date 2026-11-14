> **DRAFT for Steve to approve. Not published. Not legal advice.** The public Privacy page is the notice parents see. This draft matches the deletion the code enforces as of November 14, 2026. Change the code and the Privacy page together if a time period changes.

# Data retention policy (draft)

Personal information from a child is kept only for the purpose it was collected, and it is not kept indefinitely.

| What | Why | How long | Enforced |
|---|---|---|---|
| Browser draft, before a parent agrees | The child can keep building | Stays on the device. Not uploaded. | Publish and draft APIs refuse the draft until consent. |
| Ask-my-parent request (parent email, child first name, business name) | To ask the parent for consent | 7 days if consent is not completed | The ask record is deleted when it is read after expiry, and the sweep removes old ask rows. |
| Published page (first name, town, services, photos the parent added, Venmo name if saved) | To show the business the parent approved | Until the parent takes the page offline or deletes the account | Account deletion removes the page HTML and record. |
| Booking request | To tell the parent about a neighbor's request | About 30 days after it arrives | Requests older than 30 days are dropped when the account's requests are loaded. |
| Family calendar job | To show the job on the family's private calendar | About 30 days after the job date | The calendar feed omits older jobs. |
| Public one-booking calendar file | So a neighbor can add the time to a phone calendar | Deleted immediately when the booking is cancelled. Otherwise about 60 days after the file was saved. | Cancel deletes the file. The daily sweep deletes files older than 60 days. |
| Cloud draft after consent | So the same page opens on another device | About 90 days after the last save, or when the account is deleted | The sweep removes old drafts. |
| Parent account, email, consent, plan | To run the account | Until the parent deletes the account | Account deletion removes the account row, session, pages, requests, calendar, and public event files. |
| Trial markers | To stop a second free trial for the same email or card | Kept after account deletion. They are scrambled and are not the email address or the card number. | Account deletion leaves `trials/` and `cardtrials/` in place on purpose. |
| Sent-mail flags | To avoid sending the same operational note twice | About 400 days | The sweep removes flags older than 400 days. |
| Page-view and funnel totals | A count of visits and steps, with no name | Daily buckets, about 35 days of view days | View records keep a rolling set of days. No visitor identity is stored. |
| Abuse counters | To slow spam | Cleared within a few days | The sweep drops counter buckets older than yesterday. |

Deletion of an account is available in the app. A parent can also email support@hustlebuilder.org.
