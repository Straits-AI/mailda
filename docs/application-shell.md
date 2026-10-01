# The application shell

How the interface is put together, and why it is two interfaces rather than one.

## Two surfaces, and the seam between them

ADR 30 splits the interface at authentication:

| | Framework | Loaded |
|:--|:--|:--|
| Sign-in, first-run claim, a locked-out `doctor` | none; DOM constructed node by node | always |
| The authenticated application | React + TanStack Router/Query (§25) | on sign-in only |

The split is not a staging decision that will be tidied away. The pre-authentication screens are the ones
an operator sees **when the Node is broken**, and #23 was that case literally: a dropped binding made
sign-in return 500 and left the diagnostic the only reachable surface. A screen that needs a bundle to
render cannot be the screen you debug a broken bundle from.

So `app.client.js`, now about 360 lines down from 938, owns claim, sign-in and the session machinery,
and reaches the application through a dynamic `import("/app/shell.js")` at the moment somebody is signed
in. `shell.pre_auth_bundle_bytes: 0` in `react-shell-bundle.md` is that property as a number, and
`test/shell-split.test.ts` is what keeps it true: it fails if the served page ever references the bundle,
including via a modulepreload, and separately if the import stops being dynamic.

On sign-out the shell is unmounted before the sign-in form renders. A React root left alive over that form
keeps issuing requests that now 401 and eventually renders itself back on top of it.

## What the shell looks like

Chosen first in #32 as *variant B*, on Layer 3 rather than on taste. The next layer was *share* (shared
mailboxes, assignment, reply-collision, cases), and that needs a persistent list of mailboxes with per-item
counts and claim state. That is what a sidebar is. Route tabs are not, so choosing them would have meant
bolting one on at Layer 3 and rewriting the chrome. The redesign of 26 September 2026 kept that argument and
replaced the shape around it:

- **A grouped sidebar.** *Mail* (Inbox, Queue, Drafts, Outbox, Archive, Trash), *Workspace* (one row per
  mailbox, then People, Matters, Approvals), *Automate* (Automations, Agents), a collapsible *Admin* (Doctor,
  Limits, Audit, Log, Setup) and Settings at the foot. The sidebar scrolls rather than squeezing its rows, and a
  long mailbox name ends in an ellipsis with its counts kept. The groups render from `SIDEBAR_HOME` in
  `chrome.tsx`, a `Record<AppRoute, …>`, so a route with no home is a compile error rather than a page the
  navigation cannot reach (AGENTS.md §2c). The per-mailbox rows are #32's argument surviving: they carry the
  *unclaimed* count and how many you hold as *mine*, and they link to the queue. Nothing is hidden by role, the
  Admin group included: the screens answer 404 by §5C, and a hidden link would be a weaker copy of that decision
  (`/butlers` below said it first). Admin is collapsed until somebody opens it, and opens by itself when the
  route is one of its own.
- **Three panes for mail**: the sidebar, the list and the message, `216px · 376px · minmax(520px, 1fr)`. Below
  1120px the shell is one column and the sidebar is a modal `<dialog>` drawer behind a menu button,
  **rendered only while open**, so no off-screen link sits in the tab order and `showModal()` makes the rest
  inert. It closes on Escape or its own *Close navigation* button after the links, and gives focus back to the
  menu button. Below 768px the list and the message take turns: opening a message moves focus to its subject,
  because the row that had focus is now hidden, and the reader carries a back button named for the place
  (*Back to Inbox*, visibly *Inbox* beside an arrow) and the place's name as a visually hidden level-one
  heading, so the screen keeps one. Browser Back leaves the route at every width, as it always has: there is
  no message URL to go back to.
- **One composer, which takes the reader column**, not a route. Over a mail screen at 768px and wider it
  covers the reader column's exact box, anchored to it with CSS anchor positioning, and never the list; its
  head names what it answers (*Replying to: …*, *Forwarding: …*), because the reader it covers is where that
  was said, and the quote in the body carries the reference a reply to invoice or shipment mail exists to
  repeat. The first version docked a card over the column, which covered most of the message and left a
  clipped strip of it beside the card. On a screen with no reader column (Outbox, Queue,
  Drafts), or in a browser without anchor positioning, it is a card at the bottom right; below 768px it is
  the whole screen under the mobile bar and under the bands a screen can carry above it (*Setup is
  unfinished* and the *Notifications* band), neither of which can be dismissed, so neither may be covered: the
  last of them is its anchor. Only those two: a screen's own status line (*Matter opened.*) is not a band, so
  the dock does not start under it and it keeps the screen's margins. A browser without anchor positioning
  starts it under the bar, where it covers the bands. What it covers leaves the Tab order and the accessibility
  tree while it is open (`visibility: hidden`, in the same rules that place it, so the two cannot disagree): the
  reader column's content, or below 768px everything but the bar and the bands, and the bands too where it
  covers them. Until the fourth convergence round Tab landed on *Reply*, *Assign* and the message frame behind
  the dock, focus nobody could see (WCAG 2.4.11), and only moving focus away revealed them. The card covers the
  bottom of the column a screen scrolls in, so on a screen with no reader column that column makes room for the
  card at its tallest while it is open, and scrolls a control that takes focus above it
  (`scroll-padding-bottom`); a *Claim* in the Queue's last rows, or an Outbox row's *.eml*, sat under the card
  and nothing scrolled it clear. Over a mail screen in a browser without anchor positioning nothing makes that
  room, and the card can still cover a control. Both checked in Chromium, at 1440, 1024 and 390 px wide over the
  Inbox and at 1440 and 1024 over the Queue and 1024 over the Outbox; the rules for a browser without anchor
  positioning are not, since Chromium has it, and no test in the repository runs any of them. It lives in the
  shell rather than in a screen (`shell-context.tsx`), so it **survives navigation**, and because it does, a reply claims its case again at the moment it is sent
  (*Starting a message*, below). Closing it gives focus back to what opened it, or failing that to the
  selected row, then to *Compose*.
- **Full-width tables** for the outbox, audit trail and log. For a ledger a table is the right form, the one
  thing variant A got right, and it is kept. An outbox row whose subject is blank reads *(no subject)*, as a
  list row does, so the button that opens it has a name. Every other table that can be wider than its pane (on
  Limits, Rules, Setup, People, Butlers, Queue and Matters) scrolls sideways inside `Scroller` in `chrome.tsx`:
  a region named for its table and in the Tab order, so a keyboard can reach and scroll what is past the edge.
  The name is a required prop, so a new site cannot leave it out. Until the third convergence round these were
  unnamed `div`s no keyboard could scroll, which axe found once it audited a phone's width (*Accessibility*,
  below). The ledger sections scroll sideways too and are left as they are: each holds controls of its own. The
  Log holds none, so its table is in a `Scroller`: the 390 px sweep found it on 1 October 2026, the first time
  the swept Node had a log entry wide enough to scroll.
- **A status bar with two things in it**: whether the Node is answering, and the doctor's verdict.
  *Connected* is derived from the outcome of every query the shell makes (a request that got no answer reads
  *Unreachable*, an offline browser *Offline*); it replaced a green dot with *listening* written beside it,
  which nothing had ever computed. The word is a polite `role="status"` region that stays mounted, so a screen
  reader hears it change. *Health:* and the verdict's own word (`ok`, `degraded`, `refuse`) opens a
  popover that groups the findings into six areas (Inbound routing, Outbound mail, Worker and keys,
  Database and storage, Automation, Access and recovery) and links to Doctor. The popover reads the report
  the status bar already holds and never fetches one, because a doctor run is dozens of subrequests with
  `doctor.max_subrequests_per_run` as its ceiling (`doctor-check-cost.md`), and opening a popover is not a
  reason to spend them. A member's reduced report reads *ok in your checks* rather than *ok*, because
  the verdict still counts the findings withheld from them.

Six rows and not the five the redesign's brief drew. *Agent runtime* named nothing that exists (agents are
external principals, ADR 44, and what runs here is Butlers), so that row is §5C's word, *Automation*; and
*Access and recovery* is added because an unconfirmed recovery sheet and the legal-hold and supervision checks
can set the verdict, and a verdict no row explains is a riddle. The mapping from every check name to its row is
a `Record` over the contract's `DOCTOR_CHECKS`, so a new check with no row is a compile error, and a name a
newer Node sends that this client has never heard of lands under *Other checks* instead of breaking it.

The bottom instrument bar that the status bar replaced carried five things, and each went somewhere named:

| was in the instrument bar | now |
|:--|:--|
| the session countdown | Settings. Safe to take out of the permanent chrome because expiry is never silent without it: a failed renewal, a non-refreshable 401 and a 401 that survives a refresh all emit `signed-out` from `session.client.js`, and `app.client.js` then unmounts the shell and renders sign-in |
| *sign out* and *sign out everywhere* | Settings, with the rule unchanged: *sign out everywhere* asks the Node to revoke every session this person holds (`POST /api/auth/logout-everywhere`) and signs this page out only once it has answered, so a revocation that did not happen is rendered rather than hidden behind a signed-out page. Both save the open composer's draft first (*Drafts*) |
| the Node's hostname | Settings and the Health popover, for whoever asks |
| the outbound counts | the Outbox row's count (held and awaiting, `+` when the outbox page was cut short) and the popover's outbound row, read from the cache the sidebar already filled |
| the doctor verdict | the status bar's *Health:* |

## The brand, and the four decisions it forced (#branding)

The Mailda identity landed as a brand sheet: **Ink `#0F1720`**, **Flow Blue `#4C77B8`**, Sky, Mist, White;
Satoshi for headings and Inter for body; a continuous-line M with a blue dot. The interface before it was a
dark "instrument panel": cream on near-black, an editorial serif, one amber signal colour. Applying the
brand was therefore a repaint rather than a token swap, and four things could not simply be mapped across.

The redesign of 26 September 2026 repainted it a second time, and the first subsection below is that one.
The four after it were decided on the brand's palette; each rule survived the second repaint, and where a
value or a token's name changed, the subsection says so.

### Dark first, Dark by default, and the viewer's choice (26 September 2026)

The tokens are named by role: four grounds (`--bg-app`, `--bg-sidebar`, `--bg-list`, `--bg-reader`), four
surfaces, two dividers, `--control-edge`, three text colours, the accent pair with its hover and
`--on-accent`, and `--success`, `--warning`, `--danger`. They are declared once in `src/theme.ts` as a
`Record` per theme, so a token missing from either theme is a compile error, and the stylesheet's theme blocks
and the body frame's are built by one generator. Every value and every ratio is in
[the receipt](./receipts/contrast-tokens.md) rather than here, because a copy here would be one that can
disagree with it.

- **Dark is the default because it is the unqualified `:root`.** A page with no `data-theme`, or with
  `data-theme="dark"`, is dark on every OS; `:root[data-theme="light"]` is light; `:root[data-theme="system"]`
  is light only inside `@media (prefers-color-scheme: light)`. So the stylesheet holds exactly one
  `prefers-color-scheme` and never one for dark: an unqualified light media query would show Light to somebody
  who chose Dark on a light-mode computer.
- **The choice is the viewer's**, in Settings > Appearance: Dark, Light or System. It is kept in this browser
  (`localStorage`) and sent nowhere, because it is a preference about one screen and not an account setting,
  so a second browser starts in Dark. `/app/theme.js` is one module shared by the framework-free script and
  the React shell, exactly as `/app/delivery.js` is, and `bootTheme()` is the first statement `app.client.js`
  runs, so the claim, sign-in and locked-out `doctor` pages honour the choice too. Every storage access is
  inside a `try` and a refusal is returned rather than swallowed: Settings applies the theme first, so it is
  live whatever the browser does, then says *"Not saved in this browser; this applies until you reload."*
  when the browser would not keep it, and says so as well when it could not read a saved one.
- **System is a choice rather than the default**, because browsers report `light` when the OS states no
  preference, so following the OS alone showed Light to everybody who had never set one. Decided by the
  user on 26 September 2026.
- **A viewer who chose Light may see the sign-in page dark for a moment.** A module script runs after
  parsing, so the first paint can come before `bootTheme()`. A render-blocking classic script in `<head>` is
  the upgrade if anybody reports it, at the price of a request before every viewer's first paint, and it is
  marked `ponytail:` beside the call.
- **The body frame is told the theme on its own `<html>`.** It is opaque-origin and cannot see the shell's
  attribute, so its `srcdoc` begins with `<html data-theme="…">`, always one of the three words and never the
  shell's attribute copied through, and it loads one same-origin stylesheet, `/app/frame.css`, carrying the
  same three blocks and then rules that use only tokens. There is no `url()` and no font in it, so nothing in
  that sheet can fetch anything; the frame uses the platform's own UI sans, because a font fetched from an
  opaque origin would need CORS headers on the fonts. [`mail-security.md`](./mail-security.md) says what an
  engine that refused the sheet would show.
- **Inter stays, on six sizes in the application**: 26 px for page titles, 22 for a message's subject, 15 for
  its body, 14 for everything a person works in, 12 for metadata, and 11 for the sidebar's group labels, the one
  uppercase thing left. Weights 400 to 700, the four already served. The pre-authentication page is outside the
  scale on purpose: the redesign repainted it and did not re-set its type, so it keeps the hero type it had, a
  fluid 30 to 48 px heading, an 18 px wordmark and a 16 px lede. `test/node/type-scale.test.ts` reads the served
  sheet and fails on any other size. It was needed at once: the claim was false the day it was written (a
  toast's dismiss glyph at 16 px, now 15) and drifted again while it was being reviewed (the file control's text
  at 13 px, now 12).
- **`--mono` is a real system monospace again, for diagnostics only**: `code`, `pre`, `kbd`, header text and
  Butler source. `.mono` stays what it has been since 21 September, tabular figures in the body face, so its
  call sites (dates, addresses, counts in the ledgers) did not turn monospace.
- **A selected state carries a 2px `--accent` indicator, not only a fill**: the current sidebar row, the
  selected message, the selected tab, the current section tab and the palette's active option. The fills are
  1.1 to 1.4:1 against their ground, which is decoration and not information.
- **Fields carry `--control-edge`**, never a divider colour. A divider is 1.0 to 1.5:1 against its ground and
  would leave a field with no edge WCAG 1.4.11 recognises. Buttons carry fills instead, and a link-button
  inside text is underlined, because hue alone is not a difference WCAG 1.4.1 accepts.
- **The brand is extended, and named as extended.** The dark accent is `#78A9FF`, because Flow Blue is 3.99:1
  on Ink; in light, Flow Blue `#4C77B8` is the non-text accent and a darker blue carries text. The mark's dot
  and the favicon are unchanged (`BRAND` in `src/brand.ts`).
- **The redesign's own muted grey failed its first measurement**, 3.10:1 on a selected row, and its red
  measured 4.13:1 there. Both were adjusted before anything shipped with them, and the receipt keeps both as
  recorded defects, so a change back fails a test.

### 淼达: the brand in Chinese (30 September 2026)

In the zh-Hans interface the brand is **淼达** (Miǎodá): the shell's wordmark and the document title,
`{screen} · 淼达`. It renders in the system Simplified Chinese face, not Inter 700, with no tracking. English shows
Mailda only, and 淼达 never appears there. The sign-in and claim lockup, 淼达 with a secondary Mailda marked
`lang="en"` so a new owner connects the name to the `mailda` CLI and `mailda.site`, is built with the
pre-authentication screens' translation (layer 3), not now. `mailda` stays in every identifier. The name is a
homophone of 秒达, "arrives in seconds", a delivery slogan: the product says it cannot know delivery (ADR 39), so
秒达, 必达 and 使命必达 are never-phrases in the glossary, and no copy puns on 达. `src/brand.ts` records it. The owner
confirmed 淼达 as the mark on 30 September 2026 (the glossary review, `docs/i18n.md`). No trademark search for it has
been made; one belongs before anything public uses it.

### Flow Blue is not a text colour on two of the brand's own three grounds

Measured before anything was designed with it: **4.53:1 on white**, which clears AA for normal text by
**0.03**, then **4.11 on Mist** and **3.87 on Sky**, which fail. The brand's accent cannot carry body-size
text on the brand's own page ground.

So the accent is **two tokens split by use**, not one token compromised in value. `--accent` is the brand hex
for fills, borders, focus rings, icons and the mark's dot, for non-text contrast at 3:1, worst case 3.87.
`--accent-text` is `#436BA8`, the same hue and saturation five percent darker, for anything a person reads,
worst case 4.59. The dark theme lifts both to `#6E93CC`, because Flow Blue is 3.99:1 on Ink.
([receipt](./receipts/contrast-tokens.md))

The redesign kept the split and changed the values. Light `--accent-text` is darker again, because `#436BA8`
measured 4.27:1 on the new selected-row surface; the dark theme uses one blue, `#78A9FF`, for both, because it
clears 4.5:1 on every dark ground.

### `--signal` was doing two jobs, and the brand is what made that visible

One amber token carried the wordmark, focus rings, hover, selected rows **and** every warning state: a held
send, a throttled domain, a degraded check. The brand supplies an accent and **no** warning colour, so the
two meanings had to come apart: `--accent` took the identity and interaction half, `--warn` kept the amber for
attention. Forty-four uses, split by what each one meant rather than by find-and-replace.

The brand also supplies no error or healthy colour. `--alarm` and `--live` are kept from the old palette
rather than invented, because both were already contrast-tuned and both pass on the new grounds. That is an
extension of the brand, and it is named as one. Since the redesign the three are `--warning`, `--danger` and
`--success`, measured again on eight grounds in both themes.

### Satoshi is in the type stack and is not in the repository

Its licence permits self-hosting and forbids modifying and redistributing. Read against Mailda that second
clause is the operative one: **this repository is the distribution channel** (ADR 24 has customers clone and
merge from it), so a font committed here is redistributed from a public URL to every customer, and subsetting
it for size is precisely the modification the licence names.

So `--display` was `Satoshi, "Plus Jakarta Sans", …` until 21 September 2026: a designer with Satoshi
installed saw the brand exactly, everybody else got the closest OFL face. **The interface is one family
now.** A browser audit of every screen measured the page in three families at once, Inter for prose, the
display face for two headings, and a monospace that had drifted from figures onto labels, chips, ids and
whole message rows. `--display` and `--mono` both resolve to `--body` (Inter, four weights, 97 KB, served
from this origin); headings are weight 700 with tight tracking, figures keep their columns with
`font-variant-numeric: tabular-nums`, and machine text is weight 500 in the dim colour. Satoshi is no longer
named anywhere. (Since 26 September `--display` is gone and `--mono` is a system monospace again, for
diagnostics only; the first subsection of this section says where it applies.)

**The no-webfont rule was about third parties, not about webfonts.** `ui.ts` said for months that the
interface loads none, because "a page that fetches a font from a third party hands that third party every
viewer's IP address on every load". These are same-origin under `font-src 'self'`, which
`test/security-headers.test.ts` asserts is exactly that and nothing more. An added CDN host fails, and a
policy listing `'self'` *and* a CDN is not narrower than one listing the CDN alone. The mechanism changed and
the rule did not. ([provenance](../apps/node/worker/fonts/README.md))

### The mark in the repository is a trace of the brand sheet's raster

`src/brand.ts` holds the symbol as a filled outline traced with `potrace` from the largest raster of the
symbol the brand sheet has (18 September 2026), because there is no designer's vector. It was checked by
rendering at 300, 26 and 16 px beside the source before it shipped. The earlier by-eye path had been
described as reading correctly and did not (#128). At 300 px it is the source; at 26 px it reads as the
sheet's own 24 px row; at 16 px it is a shape, as the sheet's own favicon is. The file's header says so.

It is one edit to replace: `MARK_PATH` and `MARK_VIEWBOX` are the only values describing the geometry, and
the shell, the favicon and the app icon all derive from `markSvg()`. Until the real vector lands, the mark
should not be used for print, an app-store icon, or anything a customer reads as the identity.

The **wordmark is real text**, not a path: selectable, translatable and readable by a screen reader, where a
traced word is a picture of a word. The cost is that it renders in the interface's own face, Inter, rather
than the brand's Satoshi, which is the right trade inside the product and the wrong one for a logo file
handed to a printer.

## Paging the inbox (#91)

The list had no way to reach anything older than the newest fifty, so this screen gained the smallest control
that fixes that and deliberately not a redesign.

**A cursor stack, one page at a time**, rather than an infinite list that appends. Three reasons, in the order
they decided it:

1. Every page re-runs the whole authorization server-side (that is what the cursor carrying position only is
   for), so an appending list of ten pages refetches ten pages on every window focus. Ten authorizations, and
   for a supervised reader ten more `supervised.query` entries about mail they are not currently looking at.
2. Going back needs no reverse query. The stack holds cursors already used, so *newer* is a `pop`, and the only
   cursors ever sent are ones the Node produced.
3. A page reads as a page. An appended list reads as *"this is the mail"*, which is not a claim anything here
   can make.

The stack is component state and is meant to be: it is a scroll position, not a fact about the mailbox, so a
reload landing on the newest page is right rather than lost.

Three things the screen has to get right, and each is an honesty rule rather than a layout one:

- ***older* exists exactly when `next_cursor` is non-null**, the Node saying there is at least one more row
  this reader may see at this instant. The end of the list is an absent control, never a disabled one, for the
  same reason Compose renders nothing when somebody holds no sendable mailbox.
- **The count is a page, and it says so.** The heading reads `n` when the first page is all there is
  (`next_cursor` is null), `n+` when there is more, and *Page K* after the first; the sidebar's Inbox count
  follows the same rule. It is never a total and never *shown*, the word it used until the redesign: `50
  messages` stated a count of the archive and printed the size of a page, and a real total would be a second
  authorization-scoped `COUNT` on every listing. A page the lookback cut short (*Places, tabs and previews*,
  below) always carries a cursor, so it reads `n+`, and when it is empty it prints **no figure**, never `0`:
  the Node has not looked far enough to know. There are no page numbers to click, for the same reason.
- **An empty later page does not say "nothing has arrived yet".** That sentence is a claim about the whole Node
  and is false on page four, #101's defect in a new place. It says *"nothing older on this page"* and offers
  the way back, because the reader got there by pressing a control this screen rendered. It is reachable
  without a race, too: the Node said there was more, and by the time the reader asked for it the rows it
  counted could have been revoked.

**J and K page at the ends, and only because a key was pressed.** J on the last row, when there is an older
page, does what *Older* does and selects that page's first row; K on the first row of a later page does what
*Newer* does. Nothing is fetched ahead of a key or a click: not the next page, not a neighbour's body, because
each fetch is an authorization and, for a supervised reader, a recorded act.

`test/client/inbox-pages.test.tsx` mounts the screen for all of it, because the cursor stack is state and
`newer` is not a function anything can call.

### Narrowing: the Filter popover

`?mailbox=`, `?from=`, `?since=` and `?until=` reach the API, the SDK and the MCP tool, and each now reaches a
control too. The list pane's **Filter** button opens a popover with the mailbox, the sender's address, and
*Received on or after* and *Received on or before*. The dates say *on or* because that is what the API does:
`since` is the start of its UTC day and `until` the **end** of its (`until=2026-09-01` includes 1 September), so
*before 26 Sep* would name a range the listing contradicts. *Apply* is one request, never one per keystroke;
each active filter becomes a chip with its own remove button under the search field (*Mailbox: Billing*,
*From: …*, *On or after 1 Sep*, *On or before 26 Sep*), and the button's own name says how many are active
(*Filter, 2 active*), so a screen reader hears the count and not only a figure beside an icon.
The Node applies all four on every plan (the plain listing, the per-person tabs, Archive and Trash, and a
search), so a filter never narrows a page in the browser, where a page would be read as everything.

Five decisions worth having written down:

- **It is a control on this screen, not a sidebar row.** The sidebar lists mailboxes, so a filter here looks
  like a duplicate. It is not: the sidebar's per-mailbox rows sit under Workspace and carry *unclaimed*
  counts, work nobody has taken, which is Layer 3's subject. Repointing them at a filtered inbox would change
  what they mean rather than give them a meaning. They link to the queue and select nothing there; a
  `?mailbox=` on `/queue` is a separate change.
- **It defaults, and Compose's chooser must not** (#94). That one picks a mailbox to *send as*: per mailbox
  `send.propose`, a governance consequence, and an invisible default puts somebody's name on an address they
  did not choose. This one picks what to *look at*, so "all mailboxes" is a truthful description of an
  unfiltered list rather than a decision taken on the reader's behalf. Two controls that look alike and
  differ in exactly that, which is why the reasoning is written in both.
- **Its options are what the reader may read** (`GET /api/mailboxes/readable`, since 26 September 2026), not
  where they have work. `GET /api/mailboxes` lists mailboxes the caller holds `send.propose` on, which is the
  composer's question; a supervised reader holds none and their mailbox was missing from this filter, its mail
  reachable only unfiltered. The route existed for the agent surface and the inbox is its first screen. The
  select appears only when there are two or more to choose between.
- **The sender is the envelope sender**, the address the sending server gave, because that is what `from`
  filters, and the field's hint says it can differ from the From line on forwarded mail.
- **Changing a filter resets the cursor**, as changing the tab, the label or the search does, and that is
  correctness rather than courtesy. A cursor is a position in one ordering; narrow the listing and the row it
  names may not be in the new one at all, so the page it produces is arbitrary or empty. Nothing server-side
  can catch it. The cursor is well-formed and the authorization re-runs, so the Node correctly answers a
  question nobody asked.

The paragraph that stood here until the redesign, calling the options `useMailboxes` and naming that as an
honest limitation, was already false: it contradicted the bullet above it from the day the readable route
landed, and it is gone rather than corrected in place.

### Searching subjects, senders and bodies (#107)

`?q=` on the same listing, with a field at the top of the list pane, labelled and placeheld *Search mail*,
beside the Filter button. Words that must **all** appear in a subject line, a sender address, or a message
body; the last word matches as a prefix, so a part-typed word narrows rather than finding nothing.

**A search spans every place.** `place`, `unread` and `mine` are refused together with `q`
(`E_MESSAGE_PAGE_SEARCH_FILTER`) until their cost inside the ranked arms is measured, so the screen sends none of
them while searching and hides the tabs. The status line says so (*Searched senders, subjects and text in all
mail, including Archive and Trash*), and a row found in a place other than the one being viewed carries that
place as a chip, so a match from Trash is not mistaken for one in the Inbox.

**Bodies are a second index with a stronger authorization, and the query is a union of two arms.** The subject
and sender index answers to `mailbox.metadata.read` or `mailbox.content.read`; the body index answers to
`content.read` alone, because telling somebody *"the word demurrage occurs in message X"* discloses the
message itself one word at a time, even though the row returned carries only metadata. That is per **mailbox**.
A reader with `content.read` on Enquiries and `metadata.read` on Accounts gets body matches from the first
and subject matches from the second, in one page, from one statement. A request-level check could not express
that without either over-granting or refusing the whole search.

**The union is ordered by arrival and each arm by relevance, and that is forced.** bm25 rank is computed from
term frequency within one index, so a subject hit's rank and a body hit's rank are on different scales and
ordering the union by rank would be arithmetic on unrelated quantities. Each arm takes its own best matches;
the union, at most twice the page size, is sorted by arrival, which costs nothing over a hundred rows.

**A query whose words are split across the two indexes matches nothing.** FTS5 requires every term to appear
in the same document, and a subject and a body are two documents in two tables. Searching `hapag cabotage`
fails even when `hapag` is the subject and `cabotage` is the text. Fixing it means one index holding both,
which is exactly what the authorization split forbids. So the limitation is the price of the boundary, and it
is asserted in the suite so it stays deliberate.

**It is the same endpoint, not a new one.** `GET /api/messages` already carries authorization in the same
statement as the read (ADR 11), §7's per-page record naming the ids returned, a stable keyset cursor and the
mailbox filter. A `/api/search` route would need its own copy of all four, and `original-bytes-world.test.ts`
exists because two routes serving the same bytes authorized differently for four months. The column list and
the authorization predicate are shared between the two plans inside one builder, so they cannot diverge.

Five decisions worth having written down:

- **A searched page is a different query plan, and finding that out took three measurements.** It was built
  first as one plan: the match added to the listing as another `WHERE` predicate, keeping the time ordering
  and the cursor. That reads correctly and is 57× too slow: ordering by time while filtering by a term costs
  **O(corpus), not O(matches)**, because filling a page with the twelve newest matching messages walks all
  1,200 receipts. A rare term read 3,640 rows against a 1,000-row budget. The shipped plan is driven by the
  index, ordered by `rank`, and capped: 64 rows for the same search, which is *less than the unsearched page's
  208*. ([receipt](./receipts/message-search-cost.md))
- **So there is no pagination for a search, and the screen says so.** A full page reads *"best matches.
  Narrow the words to see others"*. This is also what the scoping decided for an unrelated reason (bm25 rank
  shifts as mail arrives, so a rank-ordered cursor would skip and repeat rows silently), and the two arguments
  landing in the same place is the only reason the cost measurement did not have to reopen a decision.
- **The field submits; it does not search as you type.** Every keystroke reaching the Node would be one
  authorization and, for a supervised reader, one `supervised.query` audit entry **per keystroke**, recording
  mail nobody looked at against `audit.max_detail_bytes`. §7 records acts and typing is not an act. Asserted
  by counting requests, because a test that only checked the final request would pass against the wrong
  implementation. The command palette holds to the same rule: typing there filters a static list of commands
  and routes in the browser and sends nothing, and its *Search mail for …* hands the term to this field, one
  request when chosen.
- **`MATCH` is a query language, so nothing the user types reaches it.** Measured against a live D1 before
  the sanitiser was written: `AND`, `NOT`, `a OR`, `foo(`, `NEAR(`, `*` and `sub:x` each return
  `fts5: syntax error`. A search box that 500s when somebody types the word "AND" is the feature not working.
  `ftsQuery` keeps letters and numbers, drops everything else and quotes each token, so the expression is
  rebuilt rather than escaped. Escaping means enumerating what is dangerous, and that list is the one that
  ends up an entry short. The consequence is that advanced syntax is unavailable, which is deliberate: a mail
  search that reads `NOT` as an operator will one day fail to find a message whose subject contains "not".
- **An empty search result is a third empty screen.** The inbox already distinguished *nothing has arrived*
  from *nothing is older than this page*; a search that matched nothing is neither, and saying the first would
  offer a reader the inbound-routing check because they misspelled a supplier's name. It names what was
  searched and offers a way to clear it. A search with no exit is a mailbox that looks empty for ever.

**The answer is announced once, and nothing else is.** The list and its status line change silently for a screen
reader, so the list pane holds a visually hidden status region, always in the page, that says one sentence when
a searched or narrowed listing has its answer: *2 matches.*, *Best N matches.* for a full page, *No mail matches
those words.*, *1 message matches these filters.*, *12+ messages match these filters.*, and on a later page
*Page 2 of the mail that matches these filters.* A narrowed page says the count's own words, which the visible
count is built from too, so it never speaks a total the screen does not print; an empty one says the empty
screen's sentence (the lookback's *None of the newest N …*, *Nothing older on this page.*, *Nothing matches
these filters.*), never a zero. It is empty while the
answer is pending and on an unnarrowed listing, so opening a message, J and K, and paging the Inbox say nothing.

**What the body index costs against ADR 28, and what it does not.** It is *contentless*, `content=''`, so
it stores the inverted index and no copy of any document. A D1 dump therefore lets somebody **confirm a
guess** (that a word appears in a message) and not read the message; bodies stay in R2, encrypted. ADR 28 was
amended in the same change to say exactly that, because its argument turned on the claim that DO-held keys
defend against a D1 dump, and this narrows it. Two consequences are enforced rather than described: body
search needs `content.read`, and the index yields **no excerpt**. `snippet()` returns `null` on a contentless
table, so showing the matching line would mean fetching and decrypting the message, which is an authorized
read. A result row may carry the message's stored **preview** (ADR 45), which is not the matching line but the
start of the body, sealed under the content key and opened only for a reader with standing content read,
exactly as on every listing row; ADR 28 was amended again to say so.

**The subject index costs nothing against ADR 28.** `subject` and `from_addr` have been plaintext
columns of `messages` since migration 0002, so an FTS5 index over them discloses nothing a D1 dump did not
already disclose. It is therefore an ordinary content-bearing FTS5 table, which buys working `snippet()`.
Measured: the contentless form returns `null` rather than an error, so highlights would have shipped blank
with nothing failing. Body search is the opposite case and needs the contentless form, because there
duplicating the text into D1 *is* the disclosure. ([receipt](./receipts/d1-fts5-search.md))

**The index row is derived, not copied.** `indexMessage` is `INSERT … SELECT subject, from_addr FROM messages
WHERE id = ?`, in the same batch as the message. Delivery is at-least-once and the message insert is
`INSERT OR IGNORE`, so a redelivery mints a fresh `msg_…` id and writes no row. An index write binding its
own copy of the values would index an id belonging to no message, which no deletion path could ever reach.
Selecting from the table makes that impossible rather than merely unlikely.

**A legal hold needs no code in the search subsystem.** The index row's lifetime is derived from the
message's, and `assertNotHeld` already refuses to delete a held message, so a hold pins the index as a
consequence of a rule enforced in one place. There is no `if (held)` here to forget. And nothing yet deletes a
message row at all. `search-scope-world.test.ts` asserts that, so the day one appears the assertion fails and
carries the rule with it, which is stronger than a delete function nobody calls. Trash did not change that:
it is a place, not a deletion (ADR 45), and the rows keyed by a message that would have to die with it,
`message_places` among them, are named in that assertion's message.

## Places, tabs and previews (ADR 45, 26 September 2026)

**Archive and Trash are places, and a place is yours.** Filing a message moves it in your own view and nobody
else's: a colleague reading the same shared mailbox keeps it wherever they left it, the unfiltered listing,
search and the thread still show it, and putting it back in the Inbox deletes only your filing row. *E* archives
the selected message and the message's *More actions* menu offers *Archive*, *Move to Inbox* and *Move to
Trash*, each for the places it is not in. The message leaves the list, so the next row is selected and **takes
focus**, as J would give it, rather than leaving focus on a row that is gone. Every move answers with a toast
(*Archived.*, *Moved to Trash.*, *Moved to Inbox.*) carrying *Undo*, and an undo that succeeds replaces it with
*Moved back to Archive.* (or wherever it was), so **Z** cannot run an undo that already finished. The *Undo*
toast stays until the next toast or until it is dismissed, because an undo that vanishes in six seconds is out
of reach of a keyboard or screen-reader user; **Z** runs it. A toast with the same words as the one before it is
announced again, since each is a new element in a live region that stays mounted. While a composer is open the
toasts move where the dock never is (over the list at full width, to the left below 1120px, over the mobile bar
below 768px), so *Undo* never lies over *Seal and send*. There is no *Delete* anywhere and no purge: Trash says
*"Trash keeps messages until you move them back. Nothing here is deleted."*, and it is true. Archiving never
closes a case and closing a case never archives: the case is the team's *done*, the place is one person's.

**Tabs: All, Unread and Mine**, on the Inbox only and hidden while searching. Each is one request the Node
answers (`unread=1`, `mine=1`, `place=inbox`), never a filter over a page in the browser, which is #91's
page-as-total defect in a new place. There is no *Waiting* tab; ADR 45 says why no honest definition of it
exists yet. The tablist is named *Inbox views* and activates manually: the arrow keys move focus along it and
Enter, Space or a click opens a tab. Opening a tab is a listing request, a recorded `supervised.query` for a
supervised reader, so looking along the row must not send three.

**Why the Inbox, Unread and Mine can stop before a page is full.** Each looks back through at most
`messages.max_lookback` of the messages you can see per request, newest first, and returns what matched with a
cursor to look further back. The bound exists for exactly the person Archive is built for: somebody who files
nearly everything, reads everything or holds few cases would otherwise make the default view read all the mail
they can see to fill one page. When a request stops at the bound with nothing to show, the list says what it
looked at and what it did not find, *"None of the newest N messages you can see is in your Inbox."* (Unread and
Mine have their own words, a filter adds *that match these filters*, and a later page says *the next N
older*), and offers **Look further back**, which is exactly *Older*: one request, onto the same cursor stack,
so *Newer* comes back here. It never says the Inbox is empty and never shows the routing sentence below, since
neither is known. *You can see* is exact: the lookback counts only messages this reader may see, so the
sentence is true and a cursor never names a receipt they cannot. N is the response's `max_lookback`, the bound
the answering Node says that request used, formatted, and neither a number written into the screen nor the
bundle's own copy of the budget, which would describe a Node running another one wrongly; when the response
names no bound the sentence names no figure. A page with some rows that the lookback cut short is an
ordinary page with a cursor, `n+` and *Older*, with no extra words.

**Archive and Trash never stop that way.** They page from the filing table's own index, so a page of either
costs a page however much mail is behind it.

**The row** shows the sender's display name, or the address when there is none, with the address as its
title; the time this Node received it; the subject, or *(no subject)* when the header was blank or could not
be read; one line of the body; and chips: *DMARC fail* first when the sender's domain disowned the message, so a
forgery is visible where triage happens rather than only after opening it, which also marks it read; then its
labels, *Mine* when you hold the case, *Held* when a colleague does, and its place when a search found it
somewhere other than the view. The selected row carries a 2px accent bar as well as its fill, and
`aria-current`.

**The name and the preview are projections**, written at ingest and by a backfill for older mail. A row the
backfill has not reached lists with its subject and address, which is what every row did before. The display
name is whatever the sender typed, so the reader always shows the address beside it, and the name is judged
before it is stored: folded with NFKC first, so a full-width `＠` or dot reads as the character it imitates;
stripped of control, format and default-ignorable characters, so a Hangul filler is not a name; then dropped if
nothing is left that is a letter or a digit, if it holds an `@`, or if it is shaped like a domain in any script,
because each is the spoof it would otherwise carry into the list. The preview is made from at most the first
16,384 characters of the body (`PREVIEW_SCAN_CHARS` in `src/preview.ts`, a provisional bound, sized and not
measured), so a reply written under a longer quote gets no preview. A row whose preview could not be made (its
evidence missing, or three reads of it failing) is `failed`, and `doctor`'s `preview_backlog` counts it; an
administrator's `POST /api/maintenance/requeue-previews` puts every failed row of the organization back in the
queue once the fault is over; the Doctor screen offers it as *Requeue failed previews* under the failing finding. The preview is opened only for a reader with standing content read on the
delivery's mailbox. **A supervised reader sees no preview at all**: a preview is message content, content under
a grant is an open recorded per message, and a listing records one query, so fifty previews would disclose fifty
messages under a record that says *listed*. Opening the message is the recorded act it always was.

**What the reader offers follows what the Node will allow**, rather than greying out what it will refuse.
*Reply*, *Reply all*, *Forward* and *Assign* appear only when the delivery's mailbox is one the reader holds
`send.propose` on, and when it is not the reader says which authority is missing: *"Replying from Support needs
send.propose on it, which you do not hold."* Read state, labels and places need standing content read (the
row's `standing_content`), so for a metadata-only or supervised reader those items are not rendered at all. The
navigation is never trimmed this way; only acts on a message are.

*More actions* is three groups with a rule between them: read state and *Add label…*, then the places, then
the original (*View headers*, *Download original*). A message's labels are chips on its *to …* line, and only
when it has some; *Add label…* opens the field in place, focused, with the hint *Label, then Enter* in it,
rather than a button standing under every message. The *to …* disclosure stays under the pointer that opens
it, and where the labels and the field fit beside it, adding a label, opening the field or moving between a
labelled and an unlabelled message does not move the actions under that line; where they do not (a phone, a
two-pane window at its narrowest with a label, or the details open) they take a line of their own, and the
actions sit that line lower while it is there. Reserving that line would put an empty one under every message
without a label, which on a phone is every message. Enter, Escape and a chip's × all give focus back to *More actions*, and so does an item that changes
nothing on screen (*Mark unread*), rather than dropping it on the page.

**Opening a message marks it read once, and refetches nothing.** The read state is patched into every cached
listing rather than invalidated, so an open costs one `/body` request and no page listing; before, every open
refetched every listing on screen, which for a supervised reader was one more `supervised.query` each time. A
message that belongs to a conversation also lists that conversation for the thread under it (its messages and
its sends), once per conversation while that answer is fresh, so J and K along one conversation read it from the
cache: for a supervised reader, one more `supervised.query` per conversation opened. It marks read once per
open, so *Mark unread* (the menu, or Shift+I) is not undone a moment later, which it was until the redesign: the
effect keyed on the read flag it had just cleared. A reader without standing content read makes no read request
at all.

**The details are one level away**: *to* followed by the address the message arrived at stays visible
(§4B.3), and opening it shows From, To, Cc, Reply-To, Delivered to, Received, the authentication results with
their sentence, and the size, then *View headers* and *Download original*. *View headers* fetches the header
block only when asked, with the body's authority and record, capped at `mime.max_header_bytes` and saying so
when it was cut. The block scrolls inside the dialog as a region named *Header block* in the Tab order, so a
keyboard can scroll one taller than the dialog; until the third convergence round it was a bare `<pre>` that
only a pointer could scroll. A long line scrolls sideways rather than wrapping: a folded line keeps the leading
whitespace that marks it as a continuation, and until the fourth round a soft-wrapped remainder started flush
left, where only a new field starts, so on a phone a relay's address read as a header of its own. *Download original* says *"Downloading is recorded as an export."* and carries no `download`
attribute: the route already sends `content-disposition: attachment`, and without the attribute a refusal opens
as the Node's words instead of being saved as a file of JSON.

**A reply waits for the body that says whom it answers.** To is the Reply-To when there is one and Cc the
other recipients, both read from the body, so R or A pressed before the body has arrived waits for it (the
reader's own request, or its cached answer, never a second read) and only then claims and opens. A body that
cannot be read claims nothing and opens nothing, and the notice says what is unknown, because a reply
addressed before the body is known goes to the From address rather than the Reply-To, and a reply-all to
nobody else.

**A refusal about a reply is said where it can be seen.** A refusal to reply or forward (a colleague holds the
case, the message is not filed yet, its body cannot be read) is said in the reader, and an open composer covers
the reader, so while one is open the same words are also raised as an alert toast naming the message, carrying
*Take it anyway* when there is a case; the inline copy then drops its alert role, so a screen reader hears the
sentence once.

**Next steps** sit below the actions and the labels: *Claim* (when the case is open and you may send; it answers
*Claimed.*), *Release* (when you hold it; *Released to the queue.*) and *More from this sender*, which filters
the list by the envelope sender. They are
deterministic, and none of them wears an AI badge (§4B.4). There is room for an AI result beside them, rendered
with its label and provenance, and nothing fills it, because no `llm.*` node runs.

## Languages (ADR 46, 30 September 2026)

The interface's words come from a typed catalog per locale (`docs/i18n.md`). English is the only language
offered; Simplified Chinese is a preview, reachable by `?locale=zh-Hans` and nowhere else, so nobody who did not
ask sees a screen that is partly English.

- **Settings > Language** sits after Appearance and is built the same way. It lists the offered languages, each
  in its own words; while English is the only one it says so instead of showing a choice that is not one. It says
  when the page is in a language only because the address asks for it, and when this browser will not let it read
  a saved choice. Choosing flushes an open draft, stores the choice in this browser and reloads; a draft the Node
  will not save stops the reload, in the Node's own words.
- **`<html lang>` and `dir`** are set by `bootLocale()`, the second call the page's one script makes after the
  theme, in the step that installs the words; the title and the pre-authentication wordmark follow.
- **Every signed-in screen has its own title**, "Outbox · Mailda", where every screen was titled "Mailda"
  (WCAG 2.4.2).
- **The Node's own English** (an error's message, a doctor finding) renders through `<NodeWords>`, marked
  `lang="en"` in a non-English interface. A failure's words may instead be this interface's own translated
  fallback, so `api.ts` carries who wrote them (`fromNode`) and a screen shows a failure with `marked()`, which
  marks only the Node's.
- **Chinese type**: Inter's own files under a second name whose range leaves the punctuation Chinese shares with
  Latin to the SC face, then the named system SC faces, then `system-ui`; tracking zeroed; the rail's labels at
  12px. No CJK webfont (ADR 30 as amended).
- **An input method's Enter is not a submit.** Every Enter handler asks `isComposingKey` first; Safari sends the
  committing Enter after `compositionend`, marked only by `keyCode` 229.
- **A message keeps its own language** (layer 2a, 1 October 2026). The body frame never takes the interface's
  `lang`; its root carries `data-script` (`sc`, `tc`, `jp`) from the message's charset, then its
  `Content-Language`, then its HTML's own `lang`, and only then the viewer's locale, and `/app/frame.css` puts that
  script's Han faces first. A plain-text body is drawn in the shell's document, so its `<pre>` carries `lang=""`
  and the same attribute. A GB2312 message in an English interface is drawn in Simplified forms; a UTF-8 one that
  says nothing gets the platform's choice. `docs/i18n.md` has the order and why.
- **A reply's quote line is in its author's language** and carries the offset from UTC ("On 8/21/2026, 17:00:00
  GMT+08:00, alice@… wrote:" / "…，alice@… 写道："); `Re:` and `Fwd:` stay English on the wire and are not added
  after `回复：`, `答复：` or `转发：`.
- **Times in a list** are `format.ts`'s: `15:09` today, `26 Sep` this year, `26 Sep 2025` before, from a written-out
  English table; `9月26日` and `2025/9/26` from `Intl` in Chinese. A time that leaves the list (a Queue deadline's
  title, a quarantine's time, a conflict) is the viewer's full local time, never a raw UTC instant.

## Keyboard

Single-key shortcuts, all switched off together by one checkbox in Settings (WCAG 2.1.4: a person using speech
input or with a tremor must be able to stop a stray letter from acting):

| key | does |
|:--|:--|
| C | Compose: the chooser when you may send from several mailboxes, the composer when one, and a sentence naming `send.propose` when none |
| R, A, F | reply, reply all, forward the selected message; a reply waits for the body and claims first, exactly as the buttons do; R again on the reply already open keeps what was typed and puts focus back in it |
| E | archive the selected message, from the place its own row says it is in, and move focus to the row that takes its place; *Already in Archive.* when it is |
| J, K | next and previous message, paging at the ends |
| Shift+I | mark the selected message unread |
| Z | run the visible toast's action, which is *Undo* |
| Cmd+K on Apple platforms, Ctrl+K elsewhere | the command palette: every route by name, *Compose*, and the selected message's commands, each gated exactly as its button is |

**One predicate decides where a key is text rather than a command**: inside an input, a textarea, a select, an
editable element, and anything inside a dialog, a menu, a listbox or the composer. `<dialog>` is named
explicitly, because an attribute selector does not match its implicit role and a key typed into the palette
would otherwise archive a message behind it. A `<summary>` or a tab button is not text entry, and keys act
there. A held key's auto-repeat is ignored (holding E must not file a message per repeat, and holding J must
not open a body per repeat, each a recorded open for a supervised reader), as are Ctrl, Meta and Alt
combinations and a key already handled. The palette's chord is a modified key, so it works while the others
are off and from inside a field. It is the platform's own: Cmd+K on Apple platforms, where Ctrl+K in a field
is the system's *delete to end of line* and is left alone, and Ctrl+K (or the Meta key) elsewhere. A held
chord opens or closes it once, its repeats swallowed rather than reaching the browser's own Ctrl+K. Its field
says *Go to or do…*; a command that has a single key shows it (*C*, *R*, *E*, …) only while single keys are
on, as *Compose*'s tooltip names *C* only then, because a hint for a switched-off key names a key that does
nothing; and the active option is kept in view as the arrows move it.

**The message list is one Tab stop.** Tab reaches the row that last had focus on this page, else the selected
row, else the first; ArrowUp, ArrowDown, Home and End move focus along it, without wrapping and without
opening anything, because an open is a recorded act and marks the message read; Enter or a click opens. One
Tab then leaves the list for the reader, where before it took one press per row. It stays a list of buttons
rather than a listbox: a `role="option"` wrapping a button is the `nested-interactive` defect axe found in
this list once.

**Focus goes back to where it came from.** Every dialog (the palette, the chooser, the headers, the drawer)
closes before it gives focus back, because while it is modal everything outside it is inert and a `focus()`
there does nothing; focus used to fall to the page after every Escape, which only a real browser showed. A
popover (Health, Filter, Assign) focuses its first field on open, or itself when it has none; Escape inside it
or on its button closes it, and so does focus landing outside both, so Tab past it never leaves it open behind.
A click on its own button closes it once, also where pressing a button does not focus it (Safari, and Firefox
on macOS): focus leaves the popover for the page during the press, and that leave is not judged while the press
is on the button, or the click would open again what the leave had closed. Checked in Chromium by emulating
that press; not run in WebKit or Firefox. A toast's *Undo* or ×
gives focus back, when the toast goes, to the control focus arrived from, or to the selected row or *Compose*
when that control has gone, never to the page. The toasts come last in the page, so by Tab that control is the
one before them (*Health*, in the status bar), not the row a message was archived from; a press on *Undo* while
a row has focus gives it back to the row. Both checked in Chromium.

**A popover opens on the side where it fits.** Each popover (Health, Filter, Assign) and the *More actions*
menu has a side it prefers, the menu leftward from its button and Assign rightward from its own, and keeps it
when it fits. When the window, or a pane that scrolls and so clips (the reader column), would cut it off at the
side, it opens on the other side, and when neither fits it is held against the nearer edge. Only the horizontal
side is corrected: whether it opens up or down (`popover-up`, `popover-down`) stays as its caller chose. It is
measured once as it opens, before it paints (`useInside` in `ui/popover.tsx`). Until the third convergence round
the side was fixed: *More actions* opened leftward from a ••• the action bar had wrapped to the column's left
edge, so at 390 px its labels were cut off and at 768 px the list pane covered them, and Assign ran past a
768 px window. *More actions* and Assign were checked in Chromium at 390, 768, 860 and 1440 px wide; Health and
Filter share `useInside` and were opened there only at 1440. No test in the repository runs it.

**The message body shows where focus is.** The body is a `sandbox=""` frame, and Tab into it fires no `focus`
on the frame element in the page, only a window `blur` with the frame as the active element; so the reader
marks the frame when the window blurs that way right after a Tab, clears the mark when the window has focus
back, and draws the accent ring on the mark. A click into the frame draws none, as `:focus-visible` would not.
Measured in Chromium only.

**A key that cannot apply says why**, in the assertive live region, rather than doing nothing: *"Replying from
Support needs send.propose on it, which you do not hold."*, *"Still reading which mailboxes you can send
from."* (also what C and the palette's *Compose* say while the mailbox list is loading, rather than claiming
you hold none), *"Filing and read state need mailbox.content.read on Support, which you do not hold."*, or
*"This message has not been filed yet. Try again in a minute."*

**The switch says when it did not stick.** It is kept in this browser; where storage is refused it still
switches the shortcuts off for this tab and says *"Not saved in this browser; this applies until you reload."*
rather than looking saved. Where the browser will not even let the page read a saved choice, the keys are on
and Settings says *"This browser would not let Mailda read a saved shortcut choice, so single-key shortcuts
start on."*, because the person this switch is for may have saved *off*, and a checked box with no sentence
would hand their stray letters back to the keys in silence.

**The composer takes focus when it opens**, in the body for a reply (before the quote) and in *To* for a new
message or a forward, so the next letter typed is text and not *A*, which would otherwise start a reply-all.

**Keys pressed inside the message body do nothing**, and that is correct rather than a gap: the body is a
sandboxed frame with an opaque origin, and its key events never reach the document. Click outside the body, or
press Tab until focus leaves it, to use them.

## The honesty rules live outside React

`delivery.client.js` is DOM-free, served at `/app/delivery.js`, and imported by the shell **at runtime
rather than bundled**. It decides which state, reason and outcome a reader is shown, and returns tokens whose
words are the catalog's (`apps/node/worker/src/i18n/en/delivery.ts`, looked up by `src/client/app/delivery-words.ts`).
Its rule: never suppress an outcome because the recipients agree, because they agree when everything bounced too.

It is a separate module because that rule was previously inside `app.client.js`, which touches `document`
at load and therefore cannot be imported by any test, and the rule was wrong for months. A send whose
every recipient bounced rendered as green `handed over`. `test/node/delivery-summary.test.ts` evaluates the
**served bytes** of that module, so what is tested and what a browser runs cannot drift.

`session.client.js` is external for a different reason: it holds the token lifecycle in module scope, so a
bundled copy would put two refresh timers on a page that also loads the framework-free script.

## Starting a message (#79)

Every outbound path this product had ran through **somebody else having written first**. The composer was
reachable only from a message's reply button, and `replyContext` was its one caller.

The composer itself was never the obstacle. `inReplyToMessageId` has always been optional and it renders
"New message" in two places. What was missing was a caller that left it out. **Compose** is that caller now,
and the context it opens is the mailbox and nothing else, three fields shorter than a reply's on purpose: no
`to`, no `subject`, no `body`. `replyContext` derives all three from the message being answered, and a
composer that opens pre-addressed to a guess is how a message goes to the wrong person.

It also claims **no case**, which is the substantive difference rather than an omission. Reply claims the
case in the same act (#42) because two people answering one correspondent is the collision that matters. A
message nobody sent has no case to claim and no collision to lose.

The mailbox is **chosen, never inferred**: From is the mailbox (ADR 36) and `send.propose` is held per
mailbox, so which one this goes from is a decision with a governance consequence. `useMailboxes` already
returns exactly the mailboxes the caller holds `send.propose` on, so the options need no separate authority
check and cannot offer one they may not use. Nothing renders when they hold none.

**That paragraph was false for as long as it existed** (#94). Nine lines under it the code read
`const chosen = from ?? rows[0]!.id`, and the `<select>` rendered with that value, so the first mailbox
looked chosen, and pressing the button without touching the dropdown sent from whichever mailbox the query
happened to return first, in an order that is not even stable. The comment described picking the first row
as the thing to avoid, and the line below it did that. What now holds:

- **One mailbox auto-selects and renders no control.** One option is not a decision, and asking for it would
  be ceremony on the commonest Node there is. The rule is narrower than "never default": a default *among
  alternatives* is never invisible, and where there are no alternatives there is no default.
- **More than one opens a chooser that starts at nothing**: a dialog, *Choose a mailbox*, whose *Start
  message* is disabled until a choice is made and disabled again if the empty choice is picked back. The
  unchosen state is a real `<option value="">`, not an absent value. A `<select>` whose value matches no
  option displays its first one anyway, which is the original bug wearing a different implementation. The
  chooser lists exactly the rows Compose was given and runs no query of its own.
- **None renders no Compose button at all**, since a button that can only fail is worse than none. Pressing
  **C** then says why, *"Sending needs send.propose on a mailbox, and you hold it on none."*, because a key
  has no button to be absent from.

The control lives in the sidebar since the redesign (in the mobile bar below 1120px, and exactly one exists at
any width), outside every screen, so it is present while the inbox is loading, when it is full, when it is
**empty**, and on every other screen too. It used to live in the inbox's heading, which was the one place
that preceded every branch of that screen.

That empty screen used to say *"This Node is claimed and routing is live"* (#101), concluded from an empty
result set, which establishes neither half. Email Routing never enabled, MX records pointing elsewhere, a
catch-all aimed at a different Worker, no address configured at all: every one produces that same screen,
so a reader whose routing was broken was told it worked, and would wait, and send a test message, and watch
that not arrive either. It is the same shape as `doctor` once shipping `workers_paid_plan: ok` over a plan
check that did not exist.

It now says only what an empty list means and links to `doctor`, whose new **`inbound_routing`** finding is
what can actually answer the question. That finding is careful about the boundary between the two halves:

- **provable from inside**: whether any address exists (no row in `addresses` means nothing routed here has
  anywhere to land, and `email()` refuses an unknown recipient), and whether anything has *ever* arrived
  (one `ingress_receipts` row proves routing reached this Worker at least once).
- **not provable**: whether Email Routing is enabled and pointing here *now*. That lives in the account,
  behind a token this Node deliberately does not hold (ADR 22, ADR 24). So "has received" is reported as
  **history, not a live status**: a Node whose routing was repointed an hour ago would otherwise read as
  healthy forever on the strength of old mail.

It is `report` severity so a correctly-installed Node with no mail yet does not turn the verdict red, and
`discloses: "data"` because the counts come from an organization's mail (§5C).

The shared `Nothing` component changed in the same pass, for the same reason. It appended *"An empty ledger.
Not a filtered one: nothing has been hidden from you"* to **every** empty state, and authorization on this
Node happens inside the SQL (ADR 11, §5), so an empty list routinely means "nothing you may see". The
screens already knew: `matters.tsx` writes *"No matters, or you do not hold org.admin"* and this sentence
contradicted it two words later on the same line. The reassurance is now opt-in via `unfiltered`, and a
caller may only assert it where the query is not narrowed by a relation.

## The composer's From, and why the words live outside React

A mailbox may have several addresses, and From used to be chosen by `ORDER BY created_at LIMIT 1`, the
oldest, so adding `billing@` to a support mailbox sent billing replies as `support@` with nothing saying so.
The Node now refuses a send from a multi-address mailbox that does not name which address, listing them, and
the composer renders a **From selector when there is a choice**, starting from *Choose an address…* so the
choice is never made for anybody (#94).

**With one address From is a line, not nothing** (28 September 2026, Blueprint §4B.3: sender identity stays
visible). It used to render no From at all, since a select with one option is furniture, and a founder who
claimed the Node as `admin@` replied for days as the mailbox's `hello@` without the screen saying so. The line
is the address and the mailbox's name, and under it a hint that an administrator adds more addresses on
People. With no address the line says so, because the send will be refused with `E_MAILBOX_HAS_NO_ADDRESS`;
while the mailboxes load it renders nothing rather than a wrong answer for a moment, and a list that failed, or
that lacks this mailbox, is said on the line, because the Node still sends as the mailbox's address. The claim
screen and `mailda install`'s claim say the same from the other end: the email signs you in, and mail goes out
from a mailbox's address, which setup chooses.

Two things about it were wrong on first render and were found by opening the composer rather than by the
suite. It sat **below the message body**, so somebody wrote the whole reply and only then met a required
field. From is identity and belongs at the top of a letter. And it was an unstyled full-width native select
among bare-underline inputs, which read as belonging to another application.

**What sending does is said beside the button, at the weight of a footnote.** *Sent as the mailbox; who wrote it
is recorded here. Held N s so you can stop it; no recall.*, with N the hold window from `/app/config.js`, and
the long form one click down behind *How sending works*. It was a three-line paragraph in the dock; the facts
stay visible and only the explanation folds.

**What a send may attach is on screen before anything is** (28 September 2026). Under *Attach*: *Up to N MB in
total, M files.*, with M `maxAttachments` and N `attachmentBudgetBytes` from `/app/config.js` taken to its raw
equivalent (three quarters) and rounded down to a tenth, MB meaning 1,048,576 bytes as the KB beside each file
means 1,024. Both figures are provisional: the file count, and the 90 per cent share of the provider's outbound
ceiling (`email.outbound.max_bytes`) behind N, have no receipt. Once files are attached the line says how much of
that they use, as the sum of the files' own sizes: in KB (to the nearest, never 0) under a tenth of a megabyte,
and in MB above that, rounded down while it fits and up once it does not, so the figure never reads as fitting
beside *Over the limit*. Whether they fit is counted as the seal counts it, from the module it refuses with
(`src/outbound/attachment-budget.ts`), each file at its base64 size, so N is the raw equivalent of the seal's
encoded budget rather than the provider's ceiling. Base64's padding can put a set over while its sizes sum to
the limit or a few bytes under, so an over figure is taken as at least one byte past the limit. Over the limit,
the line says so, in the danger tone, and *Seal and send* is disabled.

The line is a live region and the description of both buttons it disables (*Seal and send*, and *Take it anyway*
on a case somebody else holds), so a screen reader hears each reason a send became impossible and how many
attached files are judged dangerous. A file is listed the moment it is chosen and reads *Checking…* until it is
judged, and the line says *Checking files…* until every file is (in the ordinary tone, since it is a wait and not
a fault); the send waits for that, since a dangerous file sent unjudged would be refused, or, beside another
flagged file, leave without its own warning. The line does not count the checks down or count dangerous files
until judging ends, because a live region is read again whole on every change: counted per file, twenty files
were twenty-one readings. Each file's own warning appears as soon as it is judged. Files are judged one at a time, so a large selection holds one file in memory, not all of
them. A file the browser cannot read blocks the send until it is removed, because the send reads the same bytes.
While a seal runs, the list and the file picker are locked, and dimmed as any disabled button is, so what is on
screen is what is sealed. Before this
the limit was nowhere on screen and surfaced only as the seal's `E_ATTACHMENTS_TOO_LARGE`.

**A file this Node judges dangerous is sent when its author says so.** Each file is judged as it is attached (one
larger than the whole budget is not read, since it cannot be sent anyway), by
the same `classifyAttachment` the seal runs (the module is pure, so the browser imports it rather than keeping a
second copy of the rule). A dangerous one gets a warning under it naming what it is, in the reader's own words for
the verdict, and that a receiving server may refuse it. The seal then carries `allowDangerousAttachments: true`,
only while that warning is on screen. `docs/mail-security.md` has the reasoning and what the trail records.

**The send-state reading lives in `delivery.client.js`, not in the React screen**, and that placement earns its
keep; the words it names are the catalog's `send.state.*` (ADR 46). They were a literal map in `ledgers.tsx` keyed on `state` alone, which made `outcome_unknown` read *"We
do not know whether it left"* even in the one case where the Node can prove otherwise: on the authored path
the submitted bytes are stored **before** the transport is asked, so a terminal authored send with no
submitted key never reached it. That is a reading of three fields rather than a lookup on one, and it belongs
where a test can import it. `ledgers.tsx` touches `document`, which is why the outbox's previous honesty
defect (a unanimous all-bounced send rendering as "handed over") lived there uncovered until somebody looked
at the page.

**A reason beside `unobserved`: `verified destination`** (28 September 2026). Cloudflare published no delivery
event for mail to a verified destination address of the Node's own account (one verified for Email Routing
forwarding) in the one case measured (`docs/receipts/email-sending-events.md`), so such a recipient's silence is
not an answer still on its way. `GET /api/sends` carries `delivery_reason` on each recipient, derived at read time
from the Node's record of which addresses a read of the account's list showed verified at hand-over, and the
Outbox renders it as an unpainted chip **beside** the state chip `unobserved`, the same state-plus-reason
convention the send row follows (#62). It is not a state, because states are set by events alone: an event wins
the moment it lands, and `describeRecipient` in `delivery.client.js` drops the reason whenever `delivery_state` is
set. An event that sets no state (a complaint) wins too: the route names no reason for a recipient any event was
attributed to, because the chip's note would be false for that very row. The send's summary chip counts it under its own name, ranked below `unobserved` because nothing waits on it,
and a send whose every recipient is a verified destination gets that one chip rather than none, because it adds a
fact: do not wait. The words say what was measured and no more: nothing is expected, the silence is not a fault
in this Node, and it says nothing about whether the message arrived. The contract's `DELIVERY_REASONS` is the
closed list, and the catalog's `delivery.reason.*` keys are typed by it, so a token with no words, or words for a
token the contract does not name, does not compile. **Who sees it:** whoever may read the send, because the reason rides on
`GET /api/sends`, which is bounded by `mailbox.content.read`; it tells that reader the recipient was a verified
destination of the account when handed over. That disclosure is accepted, because the alternative is telling
the reader to wait for an answer that cannot come.

## Policy, and the two states it added to the outbox (#60)

A policy decision now runs inside `sealManifest`, so a send's state is a policy outcome and not only a
transport outcome. The shell's outbox therefore renders two states it did not before, and one column it did
not have.

- **`awaiting`**: a policy gated the send. Rendered in `--warning` (`--signal` when this was written), the same
  colour as `held`, because in both cases the send is waiting on a person and a fifth chip colour would need its
  own contrast measurement for no new meaning.
- **`withheld`**: this Node declined. It already existed for withdrawn send authority; a policy denial is the
  second thing that produces it.
- **`state_reason`**, a machine token beside the state, rendered as its own unpainted chip. The state says what
  happened to the send; the reason says **who can act**. `awaiting` a hold and `awaiting` an approval are the
  same state with different answers to that question, and the whole point of a reason column is that they do
  not render identically.

**The reason words live in the catalog, not in `policy.ts` and not in `ledgers.tsx`**, which is the same
placement rule the send-state words follow and for the same reason: `src/policy.ts` mints the token, one module
owns the prose (`apps/node/worker/src/i18n/en/delivery.ts` and its twins, ADR 46). Two copies of one sentence
means the authoritative one is whichever file the reader opened.

The split is **enforced in both directions**, because a placement rule nothing checks is a placement rule that
drifts on the first token somebody adds. The contract declares `SEND_STATES` and `SEND_REASONS` (the wire stays
`z.string()`); every module that writes `state_reason` types its tokens with `SendReason`, so it cannot write one
the contract lacks; the catalog's keys are typed by the same lists, so a declared token without words does not
compile; and `test/outbound-recheck.test.ts` fails when the contract declares a reason no module mints. Without
those, the outbox would fall back to rendering `policy_approval_required` at a person.

**The outbox reads itself again when a hold ends.** A `held` send leaves on its own, so the outbox and the
sidebar's Outbox count re-read five seconds after the earliest `release_at` on the page, and every five seconds
while a send is still held past its release (or its time does not parse); `awaiting` and `withheld` wait on a
person and schedule nothing. Before, a held send stayed *held* on screen until something else refreshed the
page. The wait is one timer, capped at the browser's 2^31−1 ms ceiling, because a longer delay wraps to an
immediate one and would poll without pause; a hold window is per mailbox and can be an hour.

**The stop button now offers itself on `awaiting` as well as `held`**, and that is not a convenience. Nothing
in this build clears a policy gate (releasing a hold and deciding an approval are #61's acts), so without it
the only thing a person could do with their own gated send is watch it. `cancelSend` bounds the authority to
`send.propose`, which whoever sealed it holds by definition, so nothing widened.

**There is deliberately no screen for authoring a policy.** Four routes exist (create, edit the draft,
publish, list) because a rule nothing can write is dead code, and `org.admin` is the only principal for all
four. A screen for writing rules is a design question this ticket does not settle. What the shell does show is
the *consequence*, because a state a person cannot explain is worse than one they cannot set.

## Drafts

A draft survives a reload, which is what earns the composer's middle phase, *saved on your node*, after
shipping deliberately without it.

- **The body is in R2, encrypted, not in a D1 column.** Every other piece of customer content on this Node
  is; a draft body is content, so a column would be an exception to the product's one promise for the
  convenience of the feature that needed it least. D1 holds the pointer and the metadata.
- **One object per draft**, under a stable key, so an autosave overwrites rather than accumulating an object
  per pause in typing.
- **`send.propose` authorizes it, re-checked on every save and every read.** A draft is addressed from a
  mailbox (ADR 36), so holding one is proposing a send as that mailbox, and a long-lived draft is exactly
  where "withdrawn authority stops working immediately" quietly becomes "next time you sign in".
- **Nobody reads anybody else's**, including other members of the same mailbox. Not because that is settled
  (Layer 3 decides what sharing unfinished work means) but because a guess here is a guess about who reads
  a half-written sentence about a customer.
- **One draft per reply**, enforced by a partial unique index, so replying twice resumes instead of forking
  and leaving the first to rot. The index is partial because SQLite treats every NULL as distinct: as many
  unrelated new messages as somebody likes. Every draft is listed on `/drafts` (since 26 September; from 17
  September until then, in a strip above the inbox), and opening one resumes it by id in the shell's one
  composer, so a new message put down is picked up again; a reply is still found by the message it answers.
  Opening the draft that is already in the composer keeps it, typing and all, whether it is recognised by the
  message it answers, the id it was opened with, or the id its first save was given.
  **A resumed reply carries its case**: the drafts list returns the `caseId` of the message a draft answers,
  and the composer claims that case before it seals, exactly as a reply started from the message does
  (*Starting a message*). Without it, a reply put down on Monday and sent on Tuesday would go out while a
  colleague held the case, which is the collision #42 exists to prevent, reached through a list.
- **A save that changes nothing writes nothing.** `updated_at` is shown as "saved on your node · HH:MM:SS",
  so it has to mean when the draft last *changed*, not when somebody last opened it. Guarded in
  `saveDraft`, the layer that owns the column, as well as in the composer.
- **Deleted when the message is sealed**, by the Node rather than the browser, and *after* the seal: the
  residual is a draft for a message already sent, which is visible and takes one click, rather than losing
  somebody's writing to a seal that then failed. **The row is deleted here; the R2 object is collected by the
  reconciler** (#67), and that division is deliberate rather than a leftover. `deleteDraft` issues one
  `DELETE FROM drafts` and touches R2 not at all, because ADR 32 makes reconciliation asymmetric (a
  reference with no blob may only be *reported*), so an inline delete that failed after the row was gone
  would create an object nothing could reach. Routing it through the existing collector also means **no new
  R2 delete site**: `EVIDENCE.delete` in `reconcile.ts` is still the one call in the product that destroys
  content bytes, which is the property `test/node/content-deletion-world.test.ts` exists to protect.
  What this bullet said for two months was that the object was "left for the reconciler, because ADR 32 makes
  an orphan blob collectable", which is true of ADR 32 and false of the prefix, because the reconciler listed
  `${orgId}/raw/` only and a draft body lives at `${orgId}/drafts/{draftId}.txt`. Since a draft is deleted on
  the *ordinary* send path, that made a Node's R2 usage grow with composer use, with nothing able to say so.
  The pass now scans that prefix under its own referent rule (a `drafts` row keyed by `body_key`, past the
  same grace window) and collects **the residue every existing Node already has** in the same run, with no
  migration and no separate sweep. It is gated on the org-wide legal hold (#64) and stays report-only while
  one stands, so residue in `doctor`'s `draft_bodies_stranded` finding now means the collector has not been
  run or a hold is suppressing it. `docs/evidence-lifecycle.md` has the predicate, the costs and the
  severity argument; `test/stranded-draft-bodies.test.ts` is what keeps this bullet from going stale a
  third time.
- **A legal hold refuses the deletion** (#64). A draft is addressed from a mailbox, so a hold on that mailbox
  covers it: `deleteDraft` reads the row first, tests the hold against the draft's `created_at`, and refuses
  with `E_LEGAL_HOLD` while recording the attempt as `hold.blocked`. Two consequences a reader should not have
  to discover: pressing **discard** on a held draft answers 409 with the reason, and **sending** from a held
  mailbox succeeds and keeps the draft. The seal happened, so the send route reports `draftRetained: true`
  rather than failing a message that has already left. `/drafts` then shows a draft for a sent message, which
  is the correct state under a hold and not a bug to tidy away.
- **The composer reads that 409 rather than closing over it.** `apiFetch` *resolves* for a non-ok response,
  so the first version of `discard` closed the dock as though the draft had gone while it was being preserved,
  throwing away the message the route deliberately declines to swallow. It now renders the Node's words
  verbatim in the same `role="alert"` region `seal` uses and leaves the dock open, because a person owed a
  reason has to still be looking at the thing it is about. A 404 still closes: that means the draft is already
  absent, which is what discard asked for, and the route answers it with no message for §5C's reason. Both the
  route's 409 body and the handler's reading of it are asserted, `test/legal-hold-routes.test.ts` and
  `test/node/content-deletion-world.test.ts`, the second lexically, and it says so.

- **Closing the dock flushes what the debounce has not written** (#90). The autosave lives in a
  `setTimeout` owned by an effect, and that effect's cleanup cancels the timer, which is right on every
  keystroke and was silently wrong on unmount. So for as long as drafts have existed, typing and then
  pressing **close** inside the 1.5s idle window lost everything since the last save, and on a draft that
  had never saved, all of it. The comment beside the button read *"Closing keeps the draft"*, which is
  what kept anybody from checking. `close` now calls one `flush()` and waits for it; a flush that fails
  **does not close**, leaving the dock open with the Node's own words, exactly as `discard` already did for
  a legal hold. Closing anyway with a message attached would be the same data loss, narrated.
  Two smaller things fall out of the same change and are worth naming because each was its own latent bug:
  `discard` and `seal` now wait for any write already in the air, since a PUT landing after a DELETE
  resurrects the draft and one landing after a seal resurrects a sent one; and both read the draft id from
  a ref rather than their own closure, because the write they wait for may be the one that created it.
  There is also an unmount-only effect that flushes for the paths `close` cannot cover, since cancelling
  the timer there is the same loss reached sideways. Until the redesign those were a rail link and a route
  change. The composer lives in the shell now and survives both, so it keeps autosaving across navigation.
  What unmounts it is opening a different message's composer, which replaces this one (unless this one is
  sealing, below), and the flush covers that. The unmount flush cannot cover signing out: `logout()` in
  `session.client.js` ends the session
  before it emits `signed-out`, and only then does `app.client.js` unmount the shell, so that write goes out
  with no session and is refused. Measured in Chromium on 27 September 2026: words typed into a reply followed
  at once by *Sign out*; the unmount's write was answered 401, and the draft came back without them. So
  **Settings saves the open draft before it ends the session.** *Sign out* and *Sign out everywhere* both ask
  the composer to save (`Compose.save()` in `shell-context.tsx`), and sign out only once the Node has the
  words; when it refuses them, the session stays, an alert reads *"Your draft was not saved on your Node when
  you asked to sign out, so you are still signed in:"* and the Node's own words, and the sign-out it held back is
  offered again under its own name beside the buttons: *Sign out anyway*, or *Sign out everywhere anyway*,
  which ends every session and must not read as the plain one. In
  Chromium the draft's `PUT` now precedes the logout `POST`, and the words typed in the pause reach the draft.
  What is still lost is a sign-out the Node imposes (a failed renewal, a revocation from another device): it
  arrives after the session is already gone and cannot be flushed at all.
  Discard and a successful seal close the dock too and must write nothing after it: a debounce firing while
  a DELETE is in the air, or the unmount flush after a seal, used to write the draft back, leaving a draft in
  `/drafts` for a message discarded or already sent. Discard now retires the composer before its first
  `await` and a seal as soon as its claim succeeds, and `flush()`, the one path every write takes, refuses once
  it is retired; a DELETE or a seal that is refused or never reaches the Node un-retires it, so a dock that a
  legal hold keeps open goes on saving. **A seal in the air keeps the words until the Node has answered it.**
  Close and Discard are disabled while it is, and opening another composer (R on another message, a draft in
  `/drafts`) keeps this dock and says so in the assertive region, *"Still sealing the open message. Open this
  again once the Node has answered it."*: replaced, the refusal would land on a dock nobody sees, and a seal that
  succeeded would close the new one. R on another message claims nothing while a seal is in the air: it is
  refused (`refuseWhileSealing()` on `useCompose`) before it fetches the body, and again once the body is in,
  before it claims the case, where until the third convergence round it claimed that message's case first and
  only then said the dock was sealing, and until the fourth a seal started while the body was on its way still
  met the claim. Only a seal started during the claim's own request finds the case claimed, and the refusal
  then comes from `open`, with the same words. So a
  refusal finds the dock and the words still there; and a write
  asked for meanwhile (the dock taken away, a sign-out) waits for the seal's answer first: sealed, nothing is
  written; refused, the words are written as a draft. Before this, the retired flag answered *saved* for words
  nothing had saved, and a refused seal whose dock had gone lost them.

Nothing about a draft's own lifecycle is audited. A draft is the only write path a person triggers by *typing*
rather than by deciding, and an entry per autosave would put dozens behind one human action:
`audit-and-log-retention.md`'s sizing, falsified as a side effect of a convenience. The act that *is*
audited is `send.sealed`.

The one exception is not about the draft: a deletion **refused by a legal hold** records `hold.blocked`, whose
subject is the draft id. That is an entry about an attempt to destroy held content, not about somebody's
writing, and it is at most one per send from a held mailbox, inside the same sizing.

## The build

React needs a build step, and it hangs off `wrangler.jsonc`'s `build.command` rather than our `deploy`
script, because which command a one-click install runs is Cloudflare's detection: `npx wrangler deploy`
on 6 August 2026, the root `deploy` script on 19 August (`deploy-button-install.md`), which is `mailda deploy`
since 21 August.
A build hung off a script is one detection change from absent on the install path most customers take.
Declared in wrangler's own config, the button, the CLI, a bare `wrangler deploy` and `wrangler dev` all
run it.

The output is `apps/node/worker/generated/` and is **not committed**; `react-shell-bundle.md` records both
why and what it costs. It lives outside `src/` with `watch_dir` set to `src`, because an artifact inside
the watched tree makes each build trigger the next, which looped `wrangler dev` into unresponsiveness
before it was pinned down.

Two TypeScript programs, not one: the browser half needs `lib: DOM` and JSX, and the Worker must **not**
have them, or `document` resolving inside `src/index.ts` becomes a runtime error in somebody's mailbox
instead of a type error. `pnpm typecheck` runs both.

The stylesheet is CSS inside a TypeScript template literal, `RULES` in `src/shell-css.ts` (in `src/ui.ts` until
26 September 2026), which has two hazards worth
naming because they have cost real time. A **backtick in a CSS comment** ends the literal; the build fails
loudly, so the cost is diagnosis rather than a defect. A **stray comment terminator** is the dangerous one:
the prose after it sits outside any comment, CSS error recovery consumes that prose as a selector up to the
next `{…}`, and **the rule immediately following it is silently discarded**. That shipped once. It put
`width: 100%` on the queue's subject column into the served bytes and out of
`document.styleSheets[0].cssRules`, so four consecutive layout attempts were measured honestly against a
stylesheet that never contained the rule under test. `test/node/stylesheet-hazards.test.ts` now fails on
either, and names the line. Since #97 that literal is a named constant served at `/app/app.css` rather than a
`<style>` element in the document (the next section says why), and the hazards did not move with it, so the
check matches both shapes.

## The browser policy, and what it cost the shell (#97)

Every response leaves through one wrapper, `withSecurityHeaders` in `src/security-headers.ts`, applied in
`fetch`: `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'self' data:`,
`connect-src 'self'`, `frame-src 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`,
plus `nosniff`, `no-referrer`, a `Permissions-Policy` and HSTS. Before it, this Node sent none of them, and
the reason nobody noticed is in the README: the reader's sandboxed iframe is a real defence and reads as *the*
browser-security story, when it only protects the document from the mail.

Two consequences land in this document rather than in the ticket.

**The shell contains no inline script and no inline style, and that is load-bearing.** `MAILDA_CONFIG` shipped
as an inline `<script>` and the stylesheet as an inline `<style>`. Either one forces `'unsafe-inline'`, which
permits exactly what `script-src` exists to refuse, or a per-response nonce that the header and the document
must agree on forever, a correspondence whose failure mode is a nonce repeated across a cached document. So
the stylesheet is `/app/app.css` and the config is `/app/config.js`, both same-origin assets from
`CLIENT_ASSETS` in `src/ui.ts`. `test/security-headers.test.ts` asserts the served document has neither
shape, so re-introducing one fails a test here rather than the application in a browser.

**`/app/config.js` is a module, and it is the browser's only channel for a receipt-derived number.** A JSON
endpoint was the other option and loses: `session.client.js` reads these values at module evaluation to size
the refresh margin, and making that asynchronous means the token lifecycle either waits on a request or starts
with the wrong margin, in the file whose whole job is that a signed-in person never sees a 401. A same-origin
module *is* a same-origin endpoint, and `script-src 'self'` covers it.

Since 28 September the module also carries the seal's attachment limits (`attachmentBudgetBytes`,
`maxAttachments`) from `src/outbound/attachment-budget.ts`, the module the seal refuses with. Neither is
receipt-derived as a whole: one is a receipt's ceiling times a provisional margin, the other a provisional count
(see *What a send may attach* above).

The composer reads its hold window from that module too, and the alternative is worth recording because it was
built first and looked better: the composer *is* bundled by esbuild here, so it can `import { BUDGETS }`
directly. That ships the whole 218-entry table to a browser to deliver one integer (**+7,960 bytes raw,
+2,783 gzip** measured against `react-shell-bundle.md`, whose subject is precisely what this bundle costs
somebody waiting for it) and gives the interface two sources for numbers that must agree with the Node.

**The inbox does import the table, and until 26 September this section did not say so.**
`screens/inbox.tsx` imports `BUDGETS` for `messages.page_size`, to tell a full page from a short one. (For a
day during the redesign it also read `messages.max_lookback` there, the N in its lookback sentence; that N now
comes from the Node's answer, *Places, tabs and previews*.) So the table is in the bundle whichever way the composer reads its figures, and the bytes above are spent. The
composer still reads `/app/config.js`; what changed is that keeping the table out of the bundle is no longer a
reason anybody can give for it.

It also failed #90's draft-flush test when it was tried, and that reason has since **expired**. The test then
ran on `vi.useFakeTimers({ shouldAdvanceTime: true })`, where wall-clock time also advances the fake clock,
so a slower module graph could push it past the 1,499 ms boundary it sits on. That was the test
being flaky rather than the import being expensive, and the flake is fixed at its root. The clock now moves
only when a test moves it. The bundle cost is what keeps this alternative withdrawn; the test failure was a
symptom of something else and should not be read as evidence.

So `/app/config.js` joins `/app/session.js` and
`/app/delivery.js` as an esbuild external, with hand-written types in `src/client/app/types/` and a stub at
`test/client/config-stub.ts` built from the same budgets the Worker reads.

**`frame-src` is `'self'`, not `'none'`, and the measurement says why that is not the reason it works.** The
reader renders sanitised mail into a `sandbox=""` `srcdoc` frame. Driven through a real Chromium, that frame
renders under `frame-src 'self'`, under `frame-src 'none'` and under no `frame-src` at all. A `srcdoc`
navigation inherits its parent's policy rather than being matched against a source list, so the directive is
never asked. `'self'` stays because only one engine was measured and because `'self'` is the true description
of what this application frames; `'none'` would say it frames nothing.

The inheritance is the part that matters: `default-src 'none'` applies *inside* the reading pane. That is safe
rather than lucky. The sanitiser already strips `<style>`, every `style` attribute and `src` on images, for
reasons that predate the header. Both halves are asserted.
`test/client/message-frame.test.tsx` renders the reader and checks the frame against the directive list, and
`test/security-headers.test.ts` checks the sanitiser's real output against what the policy permits.

## Routes

`src/app-routes.ts` is imported by both `index.ts` and `main.tsx`, so a route is added once. The Worker
serves the page for each of them (a bookmarked `/outbox` must not 404), and it is a **list rather than a
catch-all**, so a mistyped URL still gets a real 404 instead of an interface claiming that page exists.

`main.tsx` types its screen map as `Record<AppRoute, …>`, so adding a route and forgetting the screen is a
compile error rather than a path that serves HTML and renders nothing.

Eighteen routes now: `/`, `/queue`, `/approvals`, `/rules`, `/people`, `/matters`, `/butlers`, `/agents`,
`/limits`, `/outbox`, `/audit`, `/log`, `/doctor`, `/setup`, `/drafts`, `/archive`, `/trash`, `/settings`.

The redesign renamed no route and removed none, so every bookmark still resolves, which
`test/node/app-routes-kept.test.ts` holds. `/archive` and `/trash` are the Inbox screen given a place, not
screens of their own. `/drafts` lists drafts and `/settings` holds the account, the session, passkeys (the
*Your passkeys* section that People rendered only for administrators until the redesign, so everybody now
reaches their own), appearance and the keyboard. The sidebar groups routes without renaming them: Doctor, Limits, Audit, Log and
Setup under a collapsible *Admin*, and Butlers and Rules under *Automations*, where the two screens share
section tabs. **Rules sitting under Automations is a default taken, and it is arguable.** Rules are send
*policies*, and Blueprint §5's Admin center lists *Policies and approvals* apart from *Butlers and
automation*. The group word is a heading; the tab and the screen still say *Rules*, and moving them is one
entry in `SIDEBAR_HOME`.

`/doctor` carries the remedies its findings name, on the finding and only while it fails: apply migrations,
reseal a batch, collect orphans (two clicks, since it deletes), record a key-collision assessment, mint and
confirm recovery codes, list and requeue the body index's failures, and verify evidence a batch at a time.
Every one is `org.admin` on the Node; the screen checks nothing and renders the refusal verbatim, the way
`people.tsx` does. `mailda recovery-codes redeem` is the one act left to the terminal, because it is used when
nobody can sign in.

This list said *twelve* and left out `/agents`, under a sentence claiming *"every API this Node exposes is
reachable by a person"*. Neither was true, and the second was the expensive one: nineteen provider routes
shipped with no screen at all, reachable only through `mailda provider …`. A count nobody can check drifts;
the claim it supports drifts with it.

What is still not reachable from a screen, stated so the next reader does not have to discover it: buying a
domain, searching the registrar, the handover manifest, the ownership page, and the delivery-events read.
`/setup` covers connecting, receiving and sending.

### The first run (25 September 2026)

Until a Node can receive, the application does not show an inbox. Every screen but `/setup`, `/doctor` and
`/settings` is replaced by one page: *This Node is not ready to use yet*, the progress list, and the next step
with its action written out two ways. (`/settings` joined the exceptions with the redesign, because sign-out
lives there now and an administrator held at the gate must still be able to sign out.) The terminal way is
recommended, `curl -fsSL https://mailda.site/update.sh | bash` in the clone's directory, because it needs no
token: it uses the consent wrangler already holds. The browser way is to connect the Node from Setup and set up
receiving there. An administrator can open the app anyway, per tab, for the case where they know better than the
gate.

The readiness rule is two facts and nothing more: an address exists (`doctor`'s `inbound_routing.ok`) and
mail is routed to this Node (the routing step, read live through the grant or as the install's dated
record in the audit trail). Sending is not required to read mail, and a rule that demanded it would keep
an inbox with mail in it behind a page about DNS. Those two are the facts whose absence makes an inbox lie:
without an address nothing can be delivered, and a fresh Node's first reply refuses with
`E_MAILBOX_HAS_NO_ADDRESS`, which is the failure this page exists to put in front of the operator before
they meet it as an error.

The origin, in the founder's words after installing, updating and opening the Node: *I ran the setup
script, then the update script, then I opened the web and saw the inbox. So as a user of course I thought
it is ready to use. If not, you should only show the next setup steps and guide me until the whole thing
is ready. This should not be seen in production apps.* He was right, and the inbox he saw was on a Node
that had never been set up to receive.

### `/setup` (#210)

Connecting the Node to the Cloudflare account it runs in, without opening the Cloudflare dashboard.

The standard this screen is held to is not *"an administrator can do it"*. It is that an operator who has
never opened a terminal can finish setup, which is what the nineteen routes with no screen made impossible,
because the surface for all of them was a CLI. The two dashboard steps that remain are the two that cannot
leave it: an OAuth client this Node is not allowed to create for itself, and a consent only a human may give.
Everything after (the account read, the MX writes, the routing rule, the sending onboard) happens here.

Propose then confirm, with the digest carrying between them. `GET /api/provider/receiving` returns a plan and
a digest over it; confirming sends the digest back and the Node refuses unless the plan it would apply *now*
hashes the same. A button that posted a bare "yes" would mean *apply whatever this has become*, which on a
zone somebody has edited since is a different act from the one that was read.

**Apex or subdomain** (25 September 2026). When the domain typed is a zone's own name the proposal says so and
offers the catch-all: one rule pointing the domain's unmatched mail here, the zone's current catch-all shown
beside it (where it goes today, and that a put-back restores it), and every address without a rule of its own
thereafter managed on People. An enabled literal rule outranks the catch-all, so an address with an Email Routing
rule of its own keeps going where that rule sends it; of a disabled one Cloudflare does not say whether the
catch-all then applies, and the list's row says so rather than the heading claiming it. The box says "without a rule of its own", and beneath it the
proposal's `ownRules` lists every such address with where it goes (28 September 2026: on the live zone `sales@`,
`contact@` and `info@` went to another Worker and one more address was forwarded, and "every address" read as
all of them); rules that could not be read are said to leave the catch-all's reach unknown, never shown as none.
The outcome and People both say the same of the address being added, from the zone's rules read live. On a subdomain
Cloudflare allows literal rules only, and the screen says that each address gets its own rule, written when
the address is added. The outcome's `routing` says whether the address itself reaches this Node, in People's
words, and when it does not (a rule of its own elsewhere or disabled, nothing written, or its rules unreadable
after the catch-all was taken) its detail is shown whole, on either path.

Three things the screen must not round off, each with a test:

- **`enablesZone` with an empty `creates` is the largest act on the page, not the smallest.** Enabling Email
  Routing writes MX and SPF at the **apex**, deciding where the whole domain's mail goes, and the record
  list is empty in exactly that case, because a zone that is not routing yet lists none.
- **An empty `confirmed` means no routing rule was made.** The Node re-reads DNS after writing and leaves no
  rule when the read-back is empty, because a rule over absent records claims a domain receives mail that
  never reaches Cloudflare.
- **Refusals arrive whole.** They are four-part and the last part is what to do next, which here is the
  difference between finishing setup and going back to the dashboard to guess.

**The connection is optional, and it is one API token** (26 September 2026). Since the install sets
receiving, sending and delivery outcomes up with wrangler's login, section 1 no longer stands between a new
Node and its first message. It says what a credential of the Node's own is for, changing the Cloudflare
setup from this screen later, prints the permissions to give a token and why each is asked for, and takes
the token in a password field cleared whether or not the call worked. The state beside it is the Node's:
`no_token`, or `token_held` with the account and when it was verified, with a button that forgets the
token; a token revoked in Cloudflare is found out at the next act, whose refusal says so. The OAuth client, the consent and the two-way ceremony this
section used to carry were removed that day (ADR 42); the three steps the screen reads through the
credential fall back to `provisioned` from `GET /api/provider` when there is none: the latest receiving,
sending and subscription act from the audit trail, with its date and which credential did it. That is a
record of an act, not a live read, and the row says so in those words.

**Which recipients are verified destinations** (28 September 2026). Section 5 ends with one button, *Read
verified destinations*, which posts `POST /api/provider/verified-destinations` with the Node's token (the
section renders only when the Node holds one; `mailda setup` and `mailda upgrade` make the same read with
wrangler's login). It needs the optional permission Email Routing Addresses: Read, and the section says so.
The answer is counts, never an address: which recipients they are is the Outbox's to show, bounded by who may
read the send. Three answers, checked in this order (`test/client/setup-screen.test.tsx`):
a failed read (`error` set) renders as a refusal naming the failure as reported and the permission, and says that
the previous successful read still stands or, when there is none, that these recipients show as unobserved
until one succeeds; it never shows a count, because a failed read is could not read, not none verified. A read
with nobody handed mail to says there was nothing to compare. Otherwise it says how many of the addresses this
Node has handed mail to are verified destinations, and that the Outbox marks their hand-overs made while they
were verified (the count includes an address verified only after every hand-over to it). A refusal from the route
is rendered whole.

**Progress, derived and never stored** (24 September 2026). The screen is five numbered sections and each
knew its own state, but nothing said *two of five, next is receiving*, and nothing outside Setup said setup
was unfinished, so an inbox on a Node that cannot receive looked like an inbox. A checklist now sits under
the heading, and every step reads a structured field the Node already serves, never a sentence: the
connection state from `GET /api/provider`; `doctor`'s `inbound_routing.ok`, which means an address exists;
a domain enabled with no record still required from the email-routing read; a domain onboarded for sending,
and a subscription with a queue and a consumer, from the delivery-events read. Three states per step, and
*unknown* is its own: a source that could not be read, or one not asked because the connection is not there
yet, is not the same as *checked and not done*. The last three sources spend the grant, so only Setup reads
them; the one-line notice above every other screen reads the connection state and `doctor`, both already
fetched by the shell, and names the first of those two it can see is undone. It says nothing when both are
fine, rather than guessing at what it did not read. `src/client/app/onboarding.tsx`, with the derivation
tested in `test/client/onboarding.test.ts`.

`/oauth/cloudflare/callback` now negotiates: HTML for a browser, JSON for everything else. It is where
Cloudflare sends the operator after they agree (by construction a human is looking at it), and it answered
with raw JSON, so the last step of a flow written in English ended in a parse. `error_description` is a query
parameter reflected onto that page, on the one route with no session check, so it is escaped.

### `/matters` (#63, #64, #65, #81)

Four things on one screen because they are one sequence, not four features: something happens, somebody opens
a **matter**, mail is **held** so it cannot be deleted, somebody is allowed to **read** a colleague's mailbox
for a bounded time, and a **copy** may be taken out. Each step cites the one before it, and splitting them
across four screens would make an investigator navigate a relationship the data already has.

The matter is first because it is the thing that can **close**, and §7 requires telling the employee *after*
the matter closes. That is why `matters` is an object rather than a description field on a grant, and why
this screen is organised around it: the close button is the obligation, on the row where somebody meets it.

**Nothing here reports success it has not had.** A hold lift needs two other people, a supervised read needs
two approvals neither of them the requester, an export is approved and then run. Every act says what it
*asked for*. An investigator who believes a grant is live will act as though they can read, and they cannot.

`GET /api/holds` was added for it: `holdsForReport` was written for `doctor` and had no route, so a hold
could be placed and lifted **by id** and never listed. An administrator who placed one last month had no way
to find its id again, and a legal hold nobody can enumerate is one nobody can answer a court about.

A completed export links its manifest and, on request, every object the manifest names, each through
`GET /api/exports/:id/objects/:name`. The listing deliberately carries no object names: the manifest is the
sealed, hashed account of what left, and a second list of the same names beside it would be a copy that can
disagree with it. So the screen reads the manifest through the object route, which is the same grant check
every download passes, and anybody but the requester is answered 404 there rather than shown a list they
cannot open.

### `/limits` (#66, #81)

`GET /api/breakers` exists because of AGENTS.md's third principle rather than for a dashboard (*a limit
developers can hit is a limit they must see*), and until this screen the readings were available to a `curl`
and to nobody else. The refusal on a gated send names the budget and the limit, but only once it has already
stopped something.

**Nothing here is configurable.** Every limit is a budget generated from a receipt, so a slider would be a
number with no measurement behind it. The numbers are shown and not edited; changing one means changing the
receipt, which is a change with an argument attached.

**Unarmed is rendered as unarmed.** A breaker with too little traffic to judge shows "not enough traffic to
judge", not `0%`. A Node that has sent four messages showing a healthy-looking zero is the wrong conclusion
made easy.

The breaker's sentence ships **with** the reading rather than being written again in the client:
`RATE_BREAKERS` carries one per breaker, used by the refusal a person sees when their message is stopped, and
a second copy here would drift from it.

Domain pauses sit below, with the asymmetry stated: stopping a domain takes three administrators, restarting
one takes a single administrator alone, because a mistake in the cautious direction should be easy to undo.
The request says "asked", never "stopped". Two others have to agree first, and claiming otherwise is the one
place §5C's distinction would make somebody stop watching.

### `/people` (#39, #73, #81)

The most basic thing that was missing. Access is relationship tuples and there was no screen for any of it,
so giving a colleague access to a mailbox meant writing a `POST /api/access` by hand with a user id you could
only get from the database, and there was no list of colleagues anywhere in the product. A shared mailbox
that cannot be shared without a database client is Layer 3's premise sitting behind a wall.

Relations are shown as **what they let somebody do**. `mailbox.metadata.read` is exact and says nothing about
the consequence of granting it; "See that mail exists — senders, subjects, when. Not the message itself." is
the same fact in the form the decision needs, and the difference between that and `mailbox.content.read` is
the one an administrator is most likely to get wrong.

Two endpoints were added because the reads did not exist:

- `GET /api/people`: the directory with each person's tuples. `GET /api/access` answers for **one** subject
  and defaults to the caller, which is right for "what may I do" and useless for "who may read this mailbox".
- `GET /api/teams/:id/members`: `membersOf` was written with the sentence *"so an administrator can see who
  a grant to it reaches"* and had no route, so the only readable fact about a team was its member **count**.
  A screen given a count can render a checkbox, and the checkbox cannot be right.

It does not offer `supervised.read`: that is time-boxed, needs two approvals and cites a matter (§7), and
listing it would be offering a door that answers with a lecture.

**Adding an address writes its routing rule** (25 September 2026), when the Node holds a credential and the
domain is on a subdomain; on an apex whose catch-all points here nothing else is needed. The screen shows
the outcome beside the address: routed, already routed by the catch-all, or `not written` with the command
that writes it. The last is said in those words: an address that files and nothing routes is the state the
receiving step exists to prevent, and a green row over it would be the lie.

**Which of those it is comes from the zone's rules, read live** (28 September 2026). It used to come from this
Node's own record of taking the catch-all over, which cannot see a rule somebody else wrote: `admin@` had a
literal rule to another Worker, which outranks the catch-all, and adding it said *routed by the domain's
catch-all*. A rule on the address counts as routing here only when it is enabled and its action is a Worker
action naming this Worker; a forward, another Worker or a drop is `routed_elsewhere`, rendered whole with where
it goes and the two commands that would change it (`mailda provider --routing-rules`, which prints the digest,
then `--take-over <id> --confirm <digest>`), and never rewritten. A disabled rule is `rule_disabled`: Cloudflare
does not say whether the catch-all then applies, so the detail claims neither and names enabling or deleting it
in the dashboard, since a take-over keeps a rule disabled and so refuses one (`E_ROUTING_RULE_DISABLED`, 30
September 2026; Setup's rules table and `mailda provider --routing-rules` show that refusal in place of an act, from the rule's `offer`). When
the rules cannot be read nothing is written, since one may already route the address; on a domain whose
catch-all this Node took over that answer is `unconfirmed` and says what it could not check, never the
catch-all's *nothing to do in Cloudflare*. The catch-all itself is the listed row with no literal matcher,
which never reads as an address's own rule.

**The address is typed as its local part, with the domain fixed beside it** (28 September 2026), because a whole
address typed into a blank field was one letter from a domain the Node does not receive for. The domains are the
ones this Node receives for as far as the screen's own reads say: the receiving domain the install or Setup
provisioned (`GET /api/provider`'s `provisioned.receiving`, an audit-trail read) and the domain of every address
on a mailbox listed, both, since the mailbox list is only the caller's own. One is shown as a fixed `@domain`
suffix the field is described by; several are a picker, the provisioned one first; none leaves the whole-address
field as it was. A value typed with its own `@` is sent as typed and the suffix steps aside, so what is on screen
is what is sent. The pure part is `apps/node/worker/src/client/app/screens/people-derive.ts`. The install's
first-address prompt asks the same way: the part before `@domain`, blank being `hello`.

**Each mailbox lists its addresses, with a remove beside each** (26 September 2026, `DELETE /api/addresses`).
The list is the `addresses` column `GET /api/mailboxes` has always carried for the composer's From choice.
Removing is adding's mirror and answers in the same three words: `catch_all` (no rule of its own existed),
`rule_removed` (the literal rule naming this Worker was deleted), or `not_removed` with the reason and where
the rule still is, because a rule routing a recipient this Node no longer knows is mail arriving to bounce. It
reads the rules the way adding does, so a rule somebody has since pointed elsewhere, or disabled, is theirs
and is left alone; and a rule this Node took over is the customer's too, so it is left and the answer names
`mailda provider --put-back`, which restores where it went before.

**An address that has received mail is refused** (`E_ADDRESS_HAS_MAIL`), and the refusal is the feature. The
`addresses` row is the join every read makes from a receipt's `envelope_to` to its mailbox, so deleting it
would not delete the mail: every message under it would vanish from every queue and read while the bytes
stayed in R2, which is Blueprint §24's "accepted but absent" reachable from a button. The predicate rides on
the `DELETE` statement itself, so a delivery landing between the check and the batch is refused too. The
fix names what the person actually wants, which is for mail to stop arriving: delete the rule in Cloudflare;
the address stays as the record of what did arrive.

**Mailboxes and teams are renamed inline**: `PATCH /api/mailboxes/:mailboxId` with `name`, and the existing
`POST /api/teams/:teamId/rename`. Both record both names, because each is granted to by id and chosen by a
person reading its name, and both refuse a rename to the name already held rather than record an act nobody
took.

### Inviting somebody (#83)

How a person gets in, in one paragraph, because it was asked (26 September 2026): an administrator mints an
invitation on this screen for the person's sign-in address (`POST /api/invitations`); the link is shown
once and is not mailed, the administrator delivers it however they already trust; the person opens it and
chooses a password (`POST /api/invitations/redeem`, the one public route here); they then hold nothing
until an administrator grants a relation on a mailbox below. To receive at an address of their own, the
address is added to a mailbox they hold (*Add an address*), which under an apex catch-all is the whole act;
it is listed under that mailbox from then on, with *remove* beside it. Or tick *Also give them a mailbox at*
when inviting, and grant it when People asks, once they have an account (below).

The screen used to say it could not create a person, which was honest and not a resting state. A Node had
exactly one account and nothing else wrote to `users`, so Layer 3's whole premise had one person to exercise
it. Worse, several shipped refusals were the **only** reachable branch: a domain pause needs two other
administrators, a supervised read two other approvers, a hold lift two distinct ones, so on a one-person Node
they always refused and the governance they protect was never exercised.

An administrator mints an invitation; the person redeems it by choosing their own password. The mechanism is
`node_claim`'s, reused rather than reinvented. Only the hash is stored, `claimSecretHash` is shared, and a
lost invitation is re-minted rather than recovered.

**The administrator never learns the password**, which is the property the shape is chosen for. An
administrator who sets one and tells them becomes a permanent holder of every colleague's credential, which
is worse than the gap it fills; `set-password` is already the deliberate operator escape hatch for a lockout
and is loud about running outside the audit trail.

The secret is **shown once, on screen, with the sentence saying so**. A copy button alone would let somebody
navigate away believing the invitation had been sent. Nothing is sent, and the administrator is the delivery
mechanism. Emailing it was considered and rejected: the Node can send, which is what makes it tempting, and
it would mean posting a credential to an address nobody has verified from a mailbox whose sending capability
is itself unverified (#80).

An invitation carries **an address and nothing else**: no relations, no mailbox, no role. Somebody who
redeems one holds exactly nothing until an administrator grants access above, where the consequence of each
relation is written beside it. Pre-loading grants would mean authority arriving with an account nobody had
looked at yet, and would put one decision in two places.

**A mailbox can be made beside the invitation, and the invitee holds nothing on it** (28 September 2026). *Also give them a
mailbox at* takes a local part on one of the Node's domains, defaulting to the invitee's own when their address
is on one, and minting then runs three existing acts in order: the invitation, a mailbox named for the person
(their email, `POST /api/mailboxes`), and the address on it (`POST /api/addresses`), whose routing is said in the
Node's words beside it, a rule of its own sending it elsewhere included. The order is the refusal story: a
refused invitation leaves no mailbox, and a refused mailbox or address is said on its own line beside a secret
that still works. No route was added and the invitation still carries nothing: the administrator who makes the
mailbox may read and send from it, as the creator of any mailbox may, and the invitee holds nothing on it.

**Once they have an account, People asks** (28 September 2026): a person whose email is an address on a mailbox
they hold nothing on directly is shown as *bob@example.com has an account and holds nothing directly on the
mailbox at that address. Give them the mailbox bob@example.com?*, with one button that names what it grants,
`mailbox.content.read` and `send.propose` (what a mailbox's creator is given), through the same `POST /api/access`
as the table, one relation per call; a refusal names the relation it stopped at. It is derived from
`GET /api/people` and `GET /api/mailboxes`, nothing the invitation kept, so a mailbox at an address other than the
person's email is not matched and is granted in the table like any other. The sentence claims what those reads
show and no more: nothing observes an arrival, and a relation held through a team is filed under the team, so
"directly".

It first said *has arrived*, and an administrator's revocation brought it back (29 September 2026). Departure
is revocation here (no deactivation flag), so a person whose access to their own mailbox was withdrawn holds
nothing on it again, and was offered it back in one click. When somebody is to be asked about, People also reads
`GET /api/audit?action=access.revoked` and asks about nobody on a mailbox where a relation of theirs was
withdrawn; a revocation in the table reads it again, before the people list that would make the person a
candidate. That read failing, or an entry naming no person or object,
withholds every prompt and says why; its older entries unseen (the trail answers the newest `AUDIT_LIST_CAP`, in
`apps/node/worker/src/routes/node.ts`) is said beside the prompts.

Redemption lives in `app.client.js` beside sign-in and the claim, framework-free, because it is the screen a
person meets **before they have an account**. It cannot sit behind a bundle the shell loads after sign-in.
It is reached by a link on the sign-in panel rather than a `?invite=…` URL: an invitation is a bearer
credential, and a link would put it in browser history, in a referrer and in whatever logs sit between,
which is exactly why the claim secret is typed rather than clicked.

### `/rules` (#60, #81)

Policies, under the word a person uses for them. Each rule renders as a **sentence**, *"Mail to anyone
outside is held for a person to release."*, assembled from the same six columns the evaluator reads, so a
sentence cannot describe a condition that is not there. `outcome: hold, when_recipient_external: 1` is
accurate and tells a reader nothing about what their organization does.

The editor offers exactly six conditions because #60 stored them as typed columns rather than a blob,
precisely so a seventh that nothing evaluates cannot be written. The sixth, a reply to a message whose DMARC
failed, arrived with #260 and is one indexed read of the parent row, made only when a published policy asks. Each condition has **three** states, not two:
"not part of this rule" is different from "must be false", the column is nullable for that reason, and a
checkbox would silently turn every unticked box into a condition the evaluator now reads.

No delete, and no preview. A policy version is evidence about why a message was gated; superseding is how a
rule stops applying. "Which of my messages would this have denied" would mean a second implementation of
`evaluate` in the browser, and the evaluator's decision is already recorded on every manifest.

### Letting go a message a rule held

#60 gave `policy_hold` to any `send.propose` holder to release and nobody built the act, so for four layers
the only drain was the author cancelling their own message, the queue-with-no-drain that `deny` was kept out
of `awaiting` to avoid, and which `dispatch.ts`'s header has named as missing since it was written. Giving
`hold` a screen made it two clicks away, so the act is built: `POST /api/sends/:id/release-hold`, and *Let it
go* beside *Stop* in the outbox.

Only `policy_hold`. `awaiting` is also where an approval-gated send and a rate-broken one sit, each with its
own drain, and one button for all three would walk a message past whichever gate it was actually on. The
author is deliberately **not** excluded: a hold is a pause for a human to read what is about to go, and that
is usually the person who wrote it, which is the distinction from `require_approval`, where §18 excludes
them by design.

The Butler gate is the other one a `send.propose` holder clears, and it has its own button for the same
reason: *Release* appears on a row whose reason is `butler_release_required` and calls
`POST /api/sends/:id/release`, which puts the send back in the ordinary hold window and wakes the run that
proposed it if that run is still there. The route answers `not_found` alike for absent, already released and
not yours (§5C), so the refusal the outbox renders says all three rather than guessing which.

### `/approvals` (#81)

The first of the governance surfaces, and it went first because without it a published `require_approval`
policy made mail **undeliverable**. The outbox's only control for an `awaiting` send is *stop*, while its own
comment says the send is "cleared by an approver (#61)", an approver who had no screen. So the only
resolution through the product was for the author to cancel their own message: a stop with no drain, which is
the failure #66 kept `deny` out of `awaiting` to avoid, arriving at the surface instead of in the predicate.

**The screen decides nothing about who may decide.** `GET /api/approvals` returns `pendingApprovals`, which
computes the eligible set per subject kind and excludes the actor, so the list is already what this person
may act on. A rule about separation of duty held in the browser would be a second opinion about the thing the
mechanism exists to guarantee; `E_APPROVER_IS_ACTOR` is rendered verbatim if one ever arrives.

**Five subject kinds, shown as what they are.** A send, a hold lift, a supervised read, an e-discovery export
and a domain pause are not the same decision. Approving a supervised read lets somebody read a colleague's
mail; approving a domain pause stops a customer's. Identical rows with an id would make the gravest and the
most routine look the same, so each says what approving it does, and carries the requester's own words where
the subject kind has any.

The deadline is a header rather than a detail, because an approval can lapse and a send whose approval lapsed
is refused terminally. Somebody deciding today is the reason it will or will not make it.

### `/butlers` (#78)

The whole Layer 5 engine (interpreter, checker, run ledger, pause machinery, replay) shipped with **no
interface whatsoever**; `grep -ric butler src/client/app/` returned 0. The observation API was already
built and already careful, and nothing called it: `inspectRun` gates fact disclosure on `mayReadMetadata`
and classifies every fact as content or operational (#53), an access decision written for a screen that did
not exist, while `doctor` reported a paused Butler and gave an operator nowhere to look.

The screen carries both halves, because *"why did it do that"* is answered by the program and the run
together and splitting them would make the common diagnosis a two-screen navigation:

- **Author**: the list, the draft source, save and publish. Findings come back from the route and are
  shown verbatim. The browser deliberately does **not** validate: `checkButler` runs on the Node, and a
  second copy here would be a second opinion about what publishes.
- **Observe**: recent runs with state, the reason they ended, nodes, effects, refusals and spend; the
  pauses in force, each with the detector's own sentence and a resume that requires a written reason.
- **Run again**: `POST /api/butler-runs/:id/replay` with `mode: "re-run"`, on every finished run. The screen
  says what that is, because "replay" invites the reading that nothing happens: a **new run** of the same
  published version over the run's recorded input, judged under today's rules, whose writes are real. What
  makes it safe to offer is the release gate rather than the word: any send it proposes waits in the outbox
  for a person, so the button moves no mail on its own. Whether a run *can* be re-run (input recorded,
  version still published, Butler not paused) is the Node's answer, and its four-part refusal is shown whole.

Three things it refuses to do, each one a decision made elsewhere that a screen could quietly undo: it does
not fetch around `redactFacts`, it does not offer resume as a bare button over a machine's judgement, and
it does not hide the sidebar link from non-administrators. The screen answers 404 by §5C, and a hidden link
would be a second, weaker copy of that authority decision living in the navigation.

## The interface is tested now, which it was not

Until #90 this shell had **no automated test of any kind that rendered a component**. The suite was 1,135
tests in workerd and 204 in node, and the browser half was checked by reading it, plus a manual axe run for
structure. That is the whole explanation for a finding worth stating plainly: an external audit of this
repository confirmed seven code-level defects and **four of them were here**: a draft lost on close (#90),
a sending mailbox inferred under a comment saying it never is (#94), a recipient parser that splits inside a
quoted display name (#100), an empty inbox asserting routing is live (#101). The only unexercised layer held
most of the bugs. The 1,135 tests had nothing to say about any of them.

So there is a third config, `vitest.client.config.ts`, on the precedent `vitest.node.config.ts` set: a
separate file rather than a `projects` block, because `vitest.config.ts` carries the Cloudflare pool and
restructuring it to host a DOM would risk a stable suite for no gain. It runs `test/client/**/*.test.tsx`
under `happy-dom`, and `pnpm test` runs all three.

That sentence used to read "carries the measured timeouts and the Cloudflare pool", and it was the tell.
Both later configs gave that as their reason for being separate and **neither then set a timeout**, so both
ran at vitest's 5,000 ms default, which
[test-timeout-headroom](./receipts/test-timeout-headroom.md) exists to reject. It surfaced as a flake three
weeks later, when a `test/node/` case with a 364 ms idle cost was measured at 5,481 ms under `turbo test`.
All three configs now take the budget, all three emit a report the CI headroom ceiling reads, and
`test/node/vitest-timeout-world.test.ts` resolves every config in the repository to hold them to it. The
pool is a real reason for separate files; the timeouts never were, because a budget is one import.

Two rules about what goes in it, because the wrong answer to either makes it worse than nothing:

- **Only what needs a mount.** A plain function belongs in `test/node/`, where it needs neither a DOM nor a
  render; mounting a component to test one is slower, has more ways to be wrong, and hides that the function
  was extractable. The line is whether the *mount* is the subject. For #90 it is. No arrangement of pure
  functions expresses "the unmount cancelled the timer before the click handler's save could fire". For #94
  it also is, and that one is worth spelling out because it looks extractable and is not: the defect was
  `from ?? rows[0]!.id`, but the **property** is that a person cannot start a message without having picked
  an address, which is a claim about a disabled control and about what a click handler is handed. A
  three-line `chosenMailbox` would have tested the `??` and left the button unexercised, which is exactly
  how the original survived under a comment stating the opposite.
- **`/app/session.js` is stubbed, not real.** It is a browser-absolute specifier the bundler leaves
  external, so vitest needs to be told what it is; `test/client/session-stub.ts` is a seam that records
  calls and resolves them when the test says so. These tests are about *when* a request happens and
  *whether* one happens at all, and a real `apiFetch` would put a network in the middle of an assertion
  about a timer.
- **`/app/config.js` is stubbed for the same reason and then some.** It is not a file on disk at all, the
  Worker generates it per request. `test/client/config-stub.ts` reads the same budgets `ui.ts` reads, so a
  rendered screen shows the figure a real Node would send rather than a number typed into a test.

The tests also type-check as part of the **client** program, not the Worker's: `src/client/tsconfig.json`
includes `../../test/client/**/*` and the Worker's tsconfig excludes it. The Worker must not have `lib: DOM`
(`document` resolving inside `src/index.ts` would make a whole class of mistake compile), and checking a
test against different lib settings than the component it mounts is how a test comes to compile while the
component does not.

## Accessibility

ADR 30 requires WCAG 2.2 AA **proven**, and it takes two checks that neither replaces:

- **Contrast is computed** from the design tokens in `test/node/contrast.test.ts`, which runs in CI and
  needs no browser: every text token on every ground, and every non-text token at 3:1, in both themes. It
  began as the only way. The page carried a background gradient, and against it axe filed almost every text
  node as `incomplete` ("background color could not be determined due to a background gradient") and
  returned zero violations, so "proven by axe" would once have meant one node in fourteen examined
  (`contrast-tokens.md`). The redesign removed the gradient and every translucent surface, so axe can resolve
  the backgrounds now and checks contrast too. The computed test stays for a reason that outlived the first:
  it proves the tokens independently of which states a fixture happened to render, where axe proves only the
  pixels one run put on screen.
- **Structure and ARIA are checked by axe**, by hand, via `pnpm --filter @mailda/worker run axe -- <origin>`
  against a running Node (the `--` pnpm passes through is skipped, which until 26 September it was not, so the
  documented command crashed on `Invalid URL`); it is `scripts/axe.mjs`, not part of the suite. It runs every
  route and every opened state twice, with the theme stored as Dark and as Light (System is one of the two by
  definition), signs in with `MAILDA_AXE_EMAIL` / `MAILDA_AXE_PASSWORD`, sets the first-run gate's per-tab
  override before it navigates (without it a harness Node that is not routed shows every route as the gate, and
  the run skipped all of them), and refuses to report a run as clean when it checked nothing. The opened states,
  the wait for a view to finish loading and the growth of a page until nothing on it scrolls are in
  `scripts/sweep.mjs`, which the spacing check below walks too, so the two cannot come to open different views.
  Both take `--locale <tag>` before the origin (30 September 2026, ADR 46): every address then carries the
  `?locale=` review flag, the only way to reach a preview locale, and a state's locator on a migrated control
  reads its name from the same catalog the page renders from, so a Chinese run opens the same states.

  It **imports `APP_ROUTES`** rather than keeping its own list, and that changed because the copy had
  already drifted: its comment read "kept in step with `src/app-routes.ts` by hand, five paths" above an
  array of six. A route missing from that list is not a wrong answer, it is a screen nobody checked, which
  reads as a clean accessibility run over an unaudited page. `pnpm axe` therefore runs under
  `--experimental-strip-types` so a `.mjs` script can import the `.ts` list.

  It **injects axe through the debugger, not as a `<script>` element**, since #97. `page.addScriptTag` creates
  a real inline script, so `script-src 'self'` refuses it and every screen reported `axe is not defined`,
  which is the policy working, not a harness to work around. `page.evaluate` runs over CDP and is not page
  script. `context.bypassCSP` is deliberately not used: it would disable enforcement for the *application*
  too, so a screen broken by the CSP, the one browser-level regression this harness is now placed to notice,
  would keep rendering and keep passing. The injection is checked rather than assumed, because a library
  evaluated for its side effect returns whatever its last statement happened to be.

**Audited on 21 August 2026**, against a seeded local Node with content on every screen: 12 routes and 6
opened states × 2 themes: **36 views, 0 AA violations, 0 advisories**. It found one thing on the way, `empty-table-header` over the Butler
screen's action column, which is exactly the class of defect this check exists for and would have shipped
otherwise. The house rule that every `<th>` carries `scope="col"` came from the same pass.

**Re-audited the same day** after #87 added the Butler format selector: 30 views (the six composer and case
states could not open on a Node with no mail), **0 AA violations, 0 advisories**, including the Butler editor
in both themes. The selector is a `fieldset`/`legend` rather than a labelled pair of radios for the reason
axe would have filed as an advisory: two radios sharing a `name` are one question, and a screen reader that
announces *"json, radio, 1 of 2"* without the question has read out half of it.

Audited a third time after #87's dry-run panel landed in the same editor: **30 views, 0 AA violations, 0
advisories**. The panel's own accessibility decision is that it says why it is unusable rather than showing a
disabled control. A Butler that has never run has no delivery to test against, and *"why can I not test
this"* is a question a `disabled` attribute cannot answer.

### Spacing (28 September 2026)

*"The Add the address button is sticking to the text field."* It was 4px under it: `.field-row`'s gap is the
distance from a caption to its field, and every control placed after the field in the same row sat at that
distance too. Two checks came of it, neither of which replaces the other.

- **The measurement is `scripts/spacing.mjs`, by hand, not in CI**, for the reason axe is not: it needs a real
  browser and a running Node with content on it. It signs in with the CLI's `MAILDA_EMAIL` / `MAILDA_PASSWORD`;
  axe keeps its own pair.
  `MAILDA_EMAIL=… MAILDA_PASSWORD=… pnpm --filter @mailda/worker run spacing -- <origin>` visits every route in
  `APP_ROUTES` and every opened state in `scripts/sweep.mjs`, at 1440x900 and 390x844, in Dark and Light, grows
  each view until nothing scrolls where it can (a view that still scrolls, as the reader on a phone does, says so
  on its line), and for every pair of visible controls (a button, an `a.btn` or `a.primary`, an
  input, a select, a textarea, a summary) that share a row or a column, measures the gap between their boxes. A
  pair under 8px, or overlapping, is printed with the view, both controls and the gap, and shot with both outlined
  (`MAILDA_SPACING_OUT`, or a temp directory). It exits 1 on any such pair and on any view it could not open or
  load, and a view with no control in it counts as unmeasured rather than clean. It does not judge a pair on
  different layers (a popover over the page), a corner, or the items of one composite control, and that last is
  the one judgement it makes, written beside the list it keeps (`JOINED`): a search field and its magnifier,
  a chip's own buttons, a tablist's tabs, a menu's items, and list rows that are each one full-width control.
- **CI holds the rules, not the layout.** `test/node/control-spacing.test.ts` reads the served sheet and asserts
  that the shared rules the sweep was brought to zero with are there at 8px: the field row's second control
  (`.field-row`'s 4px plus the 4px margin the control after a field takes), the rows of controls
  (`.row-actions` and the two screens' rows that are the same row under their own names, `.inline-actions` for a
  sentence or a table cell, the reader's actions, Next steps, Hand to), the address field's wrapped rows, the @'s
  8px from the local-part field and from the domain picker (text the sweep does not measure, but the sheet's focus
  ring reaches 4px out from a control, and at 4px it touched the @), and a queue row's stacked actions. It measures no layout and says so: a more specific rule can beat any of them, and
  a screen can place two controls with no rule at all, which only the sweep sees.

The first run, against the local harness Node seeded with a second domain, three mailboxes and an arrived
invitee, before either the exemption or the growth existed, found 37 distinct pairs in 128 views. Beside the
field rows: the reader's actions and Next steps at 6px, a rule's Save draft and Cancel a text space apart (about 4px), the Cc / Bcc link 4px under To and at
the start of the row although its rule said the end (`.field-row > button` outranked it), the address field's
picker 4px under its field on a phone with its @ left behind, and the last message 3px above the Health button
on a phone with the list scrolled to its end. The rest were the message rows, the inbox tabs, the search field
and its magnifier and the overflow menu's items, which are the composite controls above, and two the sweep made
itself: a field below a pane's fold measured as overlapping the status bar, because a box a scroller clips still
reports where it would be, which growing the page first ended. After the fixes: **132 views, 0 pairs under 8px**, the Butler
resume form not applicable (no paused Butler). A rule's Publish and Open, a resend's reason and its two answers,
and an approval's Approve and Deny had the same text-space gap and were fixed by reading: the first was then
measured on a seeded draft rule, the other two need a send whose outcome is unknown and an approval waiting, which
a local Node does not have, so they were not measured. Doctor's *Verify a batch* and *Continue from where it
stopped* were a text space apart too, and the sweep missed them, because the second button renders only when a
verdict says more is left to verify: found by a review reading every control pair with the TypeScript parser, put
in `.inline-actions`, and measured with `POST /api/evidence/verify` answered by a stubbed verdict in the browser,
8px at 1440 and 390 (0px with the class taken off, since the text space went with it). Setup's catch-all box and its list of the addresses with a
rule of their own need a Cloudflare connection; they were measured once with those two reads answered by fixtures
in the browser, 0 pairs at both widths, which is evidence about layout and nothing else.

### Signing the harness in, when nobody knows a password

Written down because it took a detour to work out and the next person will hit the same wall.
`scripts/set-password.mjs` **refuses to read a password from a pipe**, deliberately, and it should keep
refusing, so it cannot be driven from a script. On a local Node whose fixture accounts have no known
password, the way in is #83's invitation flow, which is also the only way it has been exercised over HTTP:

1. hash a fresh secret with `claimSecretHash` from `src/claim-secret.ts` (a leaf module, importable from
   Node, which is why it was split out of `claim.ts`);
2. `INSERT` an `invitations` row for a new address with that hash, via
   `wrangler d1 execute CATALOG --local`;
3. `POST /api/invitations/redeem` with the secret and a password the harness chose. The response signs the
   new account in, which is the property the redemption route was built for;
4. grant it `org.admin` in `relationship_tuples`, because the Butler, policy and people routes answer 404 to
   everyone else (§5C), and a harness signed in as a non-admin audits empty screens and calls them clean.

**Interaction states are audited too (#82).** A `STATES` list beside `APP_ROUTES` opens the reply composer,
the new-message composer, the rule editor, the Butler editor, the resume form and the Queue's *Hand to…*
field on a case this person holds (with none held it claims the first open case, says so, and releases it
after the audit; until 27 September this state clicked a row, which opens nothing, and audited the Queue
again under another name; until the second convergence round its release looked for the row by the
*Hand to…* field the release takes away, so it timed out every time and reported a draft it could not discard;
until the third it found the row by its merge checkbox's name, which two cases with one subject share, so a
twin's *Claim* met its wait before the release had landed; until the fourth it pressed *Release* in the row
holding the open *Hand to…* field, which a state that failed before the field opened did not have, so its claim
stayed held; it now presses *Release* in the one row held here (`tr.case-row.mine`, the only one, since the
state claims only when nothing is held) and waits for that row to stop being held, which it does once the Node
has released the case and the queue has been read again), and since the
redesign the forward composer, the message's details, the headers dialog, the Assign popover, the reader at
390 px, the Health popover, the *More actions* menu, the Filter popover, the command palette and the mobile
drawer at 390 px, then runs the same two tag sets over each, restoring the viewport after every state. The
reply and forward states discard the draft they saved, so a run leaves no draft behind, though the case the
reply claimed, as any reply does, stays held. The *Hand to…* state claims only when no case is held here,
so a full run usually reaches it with the reply's case held and claims nothing; its release was checked in
Chromium on its own on 27 September 2026, not by the sweep, against a page built as the Queue meets it: the
claimed row, a twin with the same subject, and a quarantine row with its own *Release*. The release by the held
row was checked in Chromium on the same day against a local Node's Queue, by a copy of the script running that
state alone: once opened as usual, and once made to fail between its claim and its field, where the field's key
left the case held and this one gave it back. The Butler editor opens
the first Butler, and on a Node with none presses the product's own *New butler* and says that it left an
unpublished draft. They are where the forms are, and every defect axe has caught in this project was in
an interactive control rendered with real content: `aria-allowed-attr` on a listitem, `nested-interactive`
on the message list, `empty-table-header` on the Butler screen.

A state that fails to open reports `COULD NOT OPEN` and is counted as **unchecked**, never as passing. That is
the same distinction the route sweep draws with `SKIPPED`, and it is the reason these surfaces went unaudited
for as long as they did. The mechanism was confirmed honest by running it against a Node whose fixture had
been wiped, where it reported ten states unopened instead of passing them. A draft a state saved, and the
case the *Hand to…* state claimed, are undone whether or not the state opened, so a claim made before a state
failed is given back too, and an undo that fails says which, *could not release the case this state claimed*,
beside an audit that still stands. The reply's claim is not undone, as said above.

**One state a healthy Node can lack is reported as such, and only after the Node says so.** Only the loop
detector places a Butler pause, so a Node whose own Butler list holds none has no resume form: the run reads
that list with its own session, prints `NOT APPLICABLE … not audited`, names the state in the summary, and
neither counts it as checked nor fails on it. A refused read of that list, or a control that stops matching,
is still `COULD NOT OPEN`.

**Since 26 September a state that could not open also makes the run exit non-zero.** Counting it as unchecked
was honest in the summary and invisible in the exit code, and the reply state proved the difference: it
located its button by the name *reply*, which matched the *reply all* button as well, so Playwright refused to
pick one and every run reported the reply composer unopened, with a clean exit, for as long as both buttons
existed. The states now name their buttons exactly.

**Since 27 September a view is audited only once it has loaded**: nothing in flight for `QUIET_MS`, then no
*Reading…* notice left on the page, within `SETTLE_MS` (both bounds on the harness, not measurements). The
harness counts the requests itself, every one the page and its frames start, from before the navigation. It
first waited for Playwright's `networkidle`, which failed both ways: answered at once after its first time, it
waited for nothing a click had started, and once the reader's sandboxed body frame had attached it sometimes
never fired with nothing in flight, which failed three views on a healthy Node. A state is held to the wait
before its control is pressed and again before its audit, since what a state opens can load too. A view that
does not settle prints `COULD NOT SETTLE` with what was still loading (the requests in flight, or where
*Reading…* was still shown), is counted as unaudited, and fails the run like a state that did not open.
Before, the audit ran the moment the shell
mounted, and on the slower routes (`/agents`, `/audit`, `/people`, `/doctor`) it audited the loading notice,
in one theme and not the other: 24 to 26 rules passed there where the loaded screens pass 27 to 30.

**Since the third convergence round a route is audited whole, at three widths.** Every route is audited at
1280×720, 1024×768 (two panes, the rail a drawer) and 390×844 (one pane), in `ROUTE_VIEWPORTS`. Before each
audit the window grows until nothing on the page scrolls vertically (the document, and any element that does
so without a `max-height`), and the view is held to the wait again, since what a taller window shows can load
too. axe's `target-size` and `color-contrast` judge only what is on screen: `/agents` audited at its top read
clean, and with its pane scrolled 500 px it failed. A region with a `max-height` (the notices band, the header
block) keeps scrolling on purpose, so `scrollable-region-focusable` still judges it. A view still taller than
`MAX_HEIGHT` (a harness bound, not a measurement) is reported `PARTLY SEEN`, listed in the summary, and fails the
run; a view that grew says how far on the line after its own. The same round added three views per theme: the
first-run gate, from a context without the override, which is `NOT APPLICABLE` only when the Node renders the
shell instead, its readiness, and `COULD NOT OPEN` on anything else (until the fourth round it looked for the
message list, which a ready Node with no mail yet does not render, so such a Node failed the run); and, only on
a claimed Node (its `/health` says which), the invitation form and a refused sign-in, refused for an address no
account has, so no operator's lockout counts it.

What it still does not see: the opened states are audited at 1280×720 (the reader and the drawer at 390×844) and
are not grown; the pre-authentication pages are audited 1280 wide only; the window grows only in height, so the
columns of a table past the right edge of its `Scroller` or ledger (at 390 px, and wherever a ledger table's
52rem minimum is wider than its pane) are not on screen when axe looks, and `target-size` and `color-contrast`
do not judge them; and the header block overflows its dialog only when the newest message carries one of real
size, which the review's seeded Node did from that round on (24 `Received` hops, DKIM and an ARC set) and a
Node's own mail may not.

It runs the WCAG tags as the gate and **best-practice rules as advisories**, because the gate provably
misses things: the duplicate `main` landmark this shell shipped is `landmark-one-main`, which is tagged
`best-practice` and so invisible to an AA-only run. On the first advisory run it immediately found that the
Inbox had no level-one heading at all, and that `/log` and `/doctor` lost theirs while loading.

Current state, measured on 27 September 2026 after the fourth round of the convergence review, against a freshly
seeded local Node: **146 views, 0 AA violations, 0 advisories**, exit 0. That is, per theme, the sign-in page,
the invitation form, a refused sign-in, the eighteen routes at each of three widths, fifteen states and the
first-run gate, with the resume form not applicable (no Butler was paused). **92 unproven nodes in 8 rule
results**, all in overlay states: per theme the Filter popover 27, the palette 17, and the Health popover and the
*More actions* menu one each. Every one is `color-contrast` that axe could not decide, for two reasons. The
Filter, Health and menu nodes sit under their open popover. The palette's are its own options past the 320 px
bound of its scrolling list (options 9 to 16, never on screen when axe looks) plus its input's corner, which the
dialog's rounded clip covers. `test/node/contrast.test.ts` proves all of them from the tokens instead. They are counted in nodes as well as rules since
26 September, because a rule count alone (the review's run printed *8 unproven*) reads as eight elements when it
is dozens.

**The narrower sweep had read clean over three defects.** Before that round the sweep audited 68 views, every
route at 1280×720 and only as far as the window showed. It read 0 AA violations on the redesign, again after the
integration pass and after the first round, each time on a Node the end-to-end flow had just used, and after the
second round five times with the request count as the wait, on two Nodes (three runs on one, then two on a
freshly seeded Node the end-to-end flow had just used), with 94, 98, 96 and then 94 unproven nodes in 10 rule
results (the Filter popover lists every sender, so the count follows what the flow had delivered). With this
round's three fixes reverted, the whole-page sweep at three widths found 8 AA violations, three defects in four views in each theme:
`target-size` on `/agents` at 1280 and 1024, where single-line capability rows stood 23.3 px apart (this body's
14 px line at 1.45 is 20.3 px; a `.check` row is at least 24 px now), below the fold the old sweep never reached;
`scrollable-region-focusable` on `/limits` at 390, the breakers table scrolling sideways in a `div` no keyboard
could reach (the `Scroller` regions, *What the shell looks like*); and the same rule on the headers dialog's
block, once the fixture carried a header block that overflows. With the growth switched off, the same tree read 0
AA on `/agents` again, so the growth is what finds it. The wider sweep's first run also found the new regions repeating their
sections' names on `/people`, `landmark-unique` six times; they are named for what they hold now (*Teams and
their members*, *Who may do what in …*, *Who administers the organization*).

The redesign's first run had **2 advisories**, both `region` on the sign-in page, one per theme, were the
wordmark's rack as a `<div>`, its text outside any landmark. The rack is a `<header>` now, which clears them
and adds no second banner behind sign-in, because the shell hides the rack (`body.shell .rack { display: none
}`), both confirmed in Chromium. The review's
full run the day before found ten target-size violations with one root cause: on the five Admin routes, where
the Admin group opens by itself, the sidebar's rows shrank to fit and its *Admin* toggle measured under 24 px.
The sidebar now scrolls rather than shrinking them. The last run before the redesign: 12 screens, 0 AA
violations, 0 advisories, 12 unproven, the unproven being a background gradient the computed check covered
instead.

**One caveat worth keeping in view:** the harness measures whatever state the fixture happens to be in. The
first clean run had an empty inbox, so the message list did not exist to be checked; the moment a message
was seeded it found two serious violations in it: `nested-interactive` from a `role="option"` wrapping a
button, and a target-size failure on the list itself. A screen is only checked in the states somebody
thought to put it in.
