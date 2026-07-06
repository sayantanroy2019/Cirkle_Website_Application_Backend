
## Here we will build all the apis for backend 


## Cirkle — Product Specification
 
**Version:** 1.0 — Attendee-side complete
**Scope:** Attendee experience only. Organizer dashboard, admin/ops tooling, and database schema are out of scope for this document.
**Audience:** Engineering team building the attendee-facing product.
 
---
 
## 1. What Cirkle Is
 
Cirkle is a social layer on top of event ticketing. The core idea: nobody should have to attend an event alone, and nobody should have to coordinate a group *before* committing to go. On Cirkle, buying a ticket is what starts the social process, not the other way around.
 
Launch market: Delhi NCR, India. Event types: club nights, concerts, community trips, social mixers.
 
---
 
## 2. Core Concepts (read this before anything else)
 
These five rules are the foundation of the entire product. Every screen in this document exists to serve one of them.
 
### 2.1 Payment always comes first, unconditionally
A person can only ever do one thing first: **buy a ticket**. There is no way to "reserve a spot," "request to join," or otherwise act on an event without first paying for your own ticket to it. This is true whether you arrived through the Events tab or by tapping "Join me" on someone's group card.
 
### 2.2 A "group" is not created — it is seeded by a ticket purchase
There is no "Create Group" form anywhere in the product. The moment a person buys a ticket to an event with no group already in mind, their own existing profile (photo, name, age, lifestyle tags — all already collected at onboarding) becomes a card in the Groups feed for that event, with a single "Join me" button. No extra input is required from them — no group name, no tagline, no vibe selector.
 
The person whose ticket originated a group this way is called the **anchor**.
 
### 2.3 The anchor has sole, permanent approval authority
Only the original anchor of a group can approve or reject join requests to that group — for the entire lifetime of the group, no matter how large it grows. A member who joined later never gains approval rights.
 
### 2.4 Once a group has 2 or more people, no one can ever leave
This includes the anchor. The lock applies the moment a group crosses from 1 person to 2, even if the group is still well below its target size and still accepting new joiners. Growth can continue; exit cannot happen, for anyone, ever.
 
This is the direct structural fix for the "flaky friend cancels last-minute" problem — once a group locks, it cannot fragment.
 
### 2.5 The organizer sets the target size; hitting it unlocks the discount and closes the group
Each event has an organizer-defined group size (set at event creation, out of scope for this document). The instant a group reaches exactly that size, a discount unlocks for every member, and the group permanently stops accepting new members. The very next solo buyer for that same event becomes the anchor of a brand-new group. Multiple groups can exist in parallel for the same event at any time.
 
---
 
## 3. Onboarding & Authentication
 
### 3.1 Landing
- Entry screen, shown to anyone not yet signed in.
- Two actions: **Create account** (begins sign-up) and **Log in** (existing users go straight to the Feed).
- No content requires the user to be logged in to view this screen.
### 3.2 Phone entry
- Single field: phone number, India only (+91 prefix fixed).
- Validation: 10 digits, must start with 6, 7, 8, or 9 (standard Indian mobile number format).
- Action: **Send OTP** → navigates to OTP verification.
- Back arrow returns to Landing.
### 3.3 OTP verification
- 6 individual digit boxes, auto-advances focus to the next box as each digit is typed.
- Backspace on an empty box moves focus to the previous box.
- A 30-second countdown before "Resend code" becomes available.
- On successful verification → proceeds to onboarding step 1 (Name) for new users, or directly to the Feed for returning users whose phone number is already registered.
- Back arrow returns to Phone entry.
### 3.4 Profile setup — 7 mandatory steps
Each step is its own full screen with a progress bar (`step / 7`) and a back arrow that returns to the previous step. All 7 must be completed before reaching the Feed for the first time; none can be skipped.

 
| Step | Field(s) | Validation | Notes |
|---|---|---|---|
| 1. Name | First name, last name | Both required, minimum 2 characters each | Displayed publicly as "FirstName, Age" everywhere on the platform |
| 2. Date of birth | Day / Month / Year selectors | Must calculate to 18 years or older | Under-18 blocks progress with an explicit message; age (not DOB) is what's shown publicly |
| 3. Gender | Single select: Man / Woman / Non-binary / Prefer not to say | One must be selected | Used only for display and as context for the anchor's approval decisions — not used as a structural filter anywhere (see §18.4) |
| 4. City | Search-select from a fixed list of 15 Indian cities | One must be selected | Determines which events and groups the person sees everywhere in the app |
| 5. Lifestyle tags | Multi-select from ~10–12 tags across categories (Going out, Active & outdoors, Travel & experiences, Arts & culture, Social & community) | Minimum 3 selected | These are the tags shown on every group/anchor card and on the public profile — equivalent to "interests" on a dating app, repurposed for event compatibility |
| 6. Photos | 2–4 photo uploads | Minimum 2 required; first photo is tagged "Main" and must show the person's face | These photos are what appears on the anchor card in the Groups feed |
| 7. Email | Single email field | Valid email format required | Used only for ticket delivery and reminders — **never** used for login |
 
- Completing step 7 ("Finish setup") takes the user directly into the Feed.
---
 
## 4. App Navigation Structure
 
Once onboarded, the app has **4 persistent bottom-navigation tabs**, each a root of its own navigation stack:
 
1. **Feed** — discovery (Groups tab + Events tab)
2. **My Groups** — every group relationship the person currently has, across all events
3. **My Tickets** — every ticket the person has purchased, regardless of group status
4. **Profile** — account settings hub
Switching tabs resets that tab's navigation to its root screen; it does not preserve a "back stack" from a previous visit to that tab. Sub-screens reached by drilling into a tab (e.g., Event Detail from the Feed) use a standard back-arrow-returns-to-previous-screen pattern.
 
---