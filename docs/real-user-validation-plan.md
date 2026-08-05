# Real-User Validation Plan

The application-code release does not create or deploy a university pilot environment. Execute this
plan only after a separate environment, privacy, and operations review. Small user sessions validate
usability; they do not replace the 1,000-person PostgreSQL benchmarks in
[`performance-benchmarks.md`](performance-benchmarks.md).

## Objective and Status

This plan tests whether target users can complete the organizer and participant lifecycle without
developer explanation, whether the experience is usable enough to continue, and whether organizers
actually return. Creating this plan does not mean external validation has passed.

Recruit at least five people who:

- did not build, design, test, or receive prior coaching on Releviz
- regularly coordinate meetings or respond to scheduling requests
- represent a mix of desktop/mobile use and accessibility needs where possible

Use at least three organizer sessions and five participant sessions. A person may perform both roles
in separate scenarios, but each role/session must begin without product instruction.

## Environment and Ethics

- Use a private-beta environment and synthetic meeting details.
- Obtain informed consent for session recording and analytics.
- Do not collect real availability, confidential meeting titles, access tokens, passwords, or
  personal contact lists in research notes.
- Give participants a support contact and a way to withdraw their data.
- Mark researcher/test accounts as staff or run them in a separate environment so product metrics
  exclude internal traffic.

## Unmoderated Organizer Tasks

Provide only the goal, not UI instructions:

1. Create an event spanning at least two dates in a stated timezone and choose its continuous meeting
   duration and access mode.
2. Set a response deadline, location/method, and participant-view privacy.
3. Import the provided CSV/XLSX roster, map columns, resolve one intentional duplicate conflict, and
   commit the preview.
4. Publish the draft, identify invitation progress, and send a reminder to an eligible participant.
5. Open one temporary participant schedule for proxy entry and identify why a verified full account
   is not editable.
6. Apply a group weight/included update, override one person, and interpret the refreshed result
   basis.
7. Select a continuous recommendation, review attendance, confirm the final time, and download its
   calendar file.
8. Reopen/cancel the final meeting, then archive/delete the designated test event.

## Unmoderated Participant Tasks

1. Open the invitation and identify the organizer's timezone, deadline, location/method, and privacy
   rule.
2. Enter availability across multiple days using the participant's normal device.
3. Use a bulk action and at least one fine-grained edit.
4. Confirm that a draft saved, submit it, and identify the success state.
5. Reload or briefly disconnect, then verify recovery/retry behavior.
6. Modify or withdraw the response while the supplied business scenario permits.
7. Identify the final meeting time and calendar invitation.

At least one participant session must use a 320px mobile viewport and touch. At least one must use
keyboard-only interaction. Include a screen-reader session when a suitable participant is available;
otherwise conduct a separate expert assistive-technology audit and retain that limitation.

## Evidence to Capture

For every task record:

- start/end time and completion duration
- independent success, success with self-service recovery, assisted success, or failure
- wrong turns and repeated actions
- validation/error messages encountered
- whether help or developer explanation was required
- severe blocker, data-loss risk, privacy misunderstanding, or accessibility barrier
- device, viewport, input method, browser, and assistive technology
- anonymized session identifier and artifact links

After each session collect:

- the 10-item System Usability Scale (SUS), scored using the standard 0–100 method
- one 1–5 repeat-use-intent item
- one open-ended “most difficult” and “most valuable” response
- consented problem/feedback submission through the product

## Engineering and Product Pass Criteria

Before calling external usability validation passed:

- every P0 organizer and participant task succeeds without developer explanation
- at least 80% of all critical task attempts complete independently
- no severe privacy misunderstanding, irreversible data loss, or inaccessible primary action occurs
- mobile, keyboard, and screen-reader/assistive-semantic evidence has no critical blocker
- median SUS is at least 68, with individual low scores investigated rather than averaged away
- at least four of five users report repeat-use intent of 4 or 5

These thresholds are decision rules, not evidence. Failures become tracked issues with severity,
reproduction details, owner, correction, and retest results.

## Actual Repeat-Use Evidence

Intent is not repeat usage. Enroll eligible organizers into a 60-day follow-up:

1. Record the first real/synthetic event creation date.
2. Do not prompt them to create another event merely to satisfy the metric.
3. At day 60, calculate the defined repeat-creation cohort from production/private-beta metrics.
4. Confirm that second events represent genuine scheduling needs and are not researcher-created.
5. Report numerator, denominator, eligible cohort dates, and exclusions.

Use a planning threshold of at least 50% repeat creation among eligible organizers, but do not claim
repeat-use evidence until the 60-day observation has elapsed and the records have been reviewed.

## Evidence Template

```text
Study ID:
Date/environment/release:
Recruitment criteria and relationship to team:
Consent/recording status:
Role and scenario:
Device/browser/viewport/input/assistive technology:

Task | Start | End | Outcome | Help needed | Severe issue | Evidence link

SUS raw answers and score:
Repeat-use intent (1-5):
Most difficult:
Most valuable:
Submitted feedback ID:
Issues created and severity:
Retest release/result:
```

The final study report must separate engineering validation, external task success, SUS, stated
intent, and observed repeat usage. Until all are available, the highest maturity label is
`production candidate`.
