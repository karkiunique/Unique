# Lead-source vendor emails — platform/embedded terms

Two enquiries, ready to send from your own address. Both ask the same underlying question:
**may a product source leads on behalf of its own end users, using one integration?**

Send them **in parallel**, not sequentially — this is the long pole on the daily draft queue
(CLAUDE.md, Decisions 2026-08-16) and neither reply will be quick.

## Before you send

- Send from your real domain, not a free mailbox. You are asking to be treated as a platform partner;
  the address is the first evidence either way.
- **Do not describe Unique as a cold-outreach or sales-sequencing tool to Apollo.** Not because it is
  untrue, but because Apollo's API terms §5(i) bar use that "replicate[s] or compete[s] with any
  Apollo products or services, **as determined by Apollo in its sole discretion**", and Apollo sells
  outbound sequencing. Lead the description with what is genuinely distinct: it writes in the user's
  own voice and every send is human-approved. That is accurate and it is the part Apollo does not do.
- Expect to be routed to a partnerships or solutions team. Ask for the answer **in writing**. A
  salesperson saying "sure, that's fine" on a call is not an authorisation under §3.
- Volume is genuinely small — around 60 lookups per user per month. Say so. It changes which pricing
  conversation you end up in, and it is honest.

---

## Email 1 — Apollo

**To:** support@apollo.io — ask to be routed to partnerships/API licensing
**Subject:** API licensing for an embedded use case — platform sourcing on behalf of end users

> Hi,
>
> I'm building Unique, a B2B product that helps people write outreach in their own writing style.
> It connects to a user's mailbox, learns how they actually write, drafts letters that sound like
> them, and requires the user to read and approve every message before anything is sent. Sending
> happens from the user's own account, one message at a time.
>
> I'd like to use Apollo to find and resolve contacts, and I want to get the licensing right before
> I build anything.
>
> The model is that Unique holds one Apollo integration and performs lookups **on behalf of each
> end user**, against targeting criteria that user has set. Reading your API Terms, §2 and §3 appear
> to cover this — §3 prohibits integrating the APIs with a product or service "unless Apollo has
> authorized or approved such access or integration". So I'm writing to ask for that approval, or to
> be told the correct structure.
>
> Specifically:
>
> 1. Is there a platform, OEM, or partner agreement that permits an application to query Apollo on
>    behalf of its own end users?
> 2. If not, is "bring your own key" acceptable — each of my users connects their own Apollo account
>    and their own credits, with Unique acting only as the client?
> 3. What are the constraints on storing results? I'd persist a contact's name, company, title and
>    email for the user who requested it, so they can review the draft before sending.
>
> Volume is deliberately low: roughly 60 contact lookups per user per month.
>
> Happy to jump on a call or share more detail.
>
> Thanks,
> Unique Karki

**Why it is worded this way.** It cites §3 directly, which signals you have read the terms and are
asking for the authorisation the clause contemplates rather than hoping nobody checks. Question 2
gives them an easy "no, but do it this way" that still unblocks you. Question 3 matters because
their terms are silent on storage and you need that in writing, not inferred.

---

## Email 2 — Hunter

**To:** support@hunter.io
**Subject:** API terms for embedded use — lookups on behalf of our end users

> Hi,
>
> I'm building Unique, a product that drafts outreach in a user's own writing style, with every
> message reviewed and sent by the user themselves.
>
> I'd like to use Hunter for contact discovery and email verification, and I want to confirm the
> licensing before building. Two things I could not resolve from your public pages — your Terms of
> Service URL currently 404s from a few paths, so I would rather ask than assume:
>
> 1. Does your standard API licence permit an application to perform lookups **on behalf of its own
>    end users**, or does that require a separate agreement? Each lookup is initiated by a specific
>    user against criteria they set; results are shown only to that user.
> 2. What are the terms around storing verification results and contact records for the user who
>    requested them?
>
> Volume would be around 60 lookups plus verifications per user per month, so a shared credit pool
> fits us better than per-seat licensing.
>
> If there is a platform or partner tier that covers this, I'd like to see it.
>
> Thanks,
> Unique Karki

**Why it is worded this way.** Naming the 404 is true and gives them a low-friction reason to send
the actual document — which is what you need, since nothing about Hunter's position has been
verified. Mentioning the credit pool signals you have understood their model, which is the thing that
makes them a better structural fit than Apollo for a platform.

---

## What to do with the answers

Record both replies in `CLAUDE.md` under Decisions, verbatim where the wording matters. Whichever
lands first determines Stage B; if both refuse platform terms, BYOK is the fallback and the
onboarding cost gets designed around it.

Stage A does not wait on any of this.
