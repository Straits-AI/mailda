-- Send circuit breakers: three windowed rates, one latched domain pause (#66, §18, Layer 5).
--
-- Additive (#10 expand/contract): two indexes, one new table with its own indexes, and one column
-- rename on approvals. No DROP TABLE, no DROP COLUMN, no bookmark gate.
--
-- ## Two kinds of breaker, and the split decides what this file contains
--
-- A **rate** breaker is not a latch, it is a question re-asked on every send: too much, too fast, and
-- the mail is still wanted. So volume, bounce rate and complaint rate have **no table here at all** --
-- they are a windowed COUNT(*) over rows that already exist, the login_attempts shape at
-- src/auth/session.ts:164. Nothing to increment, so nothing to contend on, no CAS, and no cell that can
-- drift from the events it summarises: the number is derived, not maintained. What those rates need
-- from a migration is an index, and that is the first half of this file.
--
-- An **abuse** breaker means this must not be sent at all, so it latches. domain_pauses is that row.
--
-- ## Every rate counts attributed events only, and this is where the index says so
--
-- send_recipient_events has a **second writer**. recordDeliveryReport (src/outbound/delivery-report.ts)
-- inserts event_type = 'inbound.delivery_report' with terminal = 1 and manifest_id **NULL** for delivery
-- reports about *other systems' mail* -- its own header says whose: "mail sent by some other system on
-- the same domain, a report forwarded by a person, a report for something relayed before Mailda
-- existed". A naive COUNT(*) over this table would trip this Node's breaker on somebody else's bounces,
-- which is the read-a-wrong-number inversion a breaker exists to prevent, sitting in the substrate a
-- breaker would naturally reach for.
--
-- The discriminator already exists on the same insert -- manifest_id = manifest?.id ?? null -- and
-- Layer 4 already applied exactly this split for doctor's blindness check, after an unattributable
-- delivery event made the Node look less blind than it was. So the predicate is
-- manifest_id IS NOT NULL, it is in the SQL rather than only in a comment (src/breakers.ts), and this
-- index is its mirror image: sre_unattributed below already indexes the complement, and the two
-- together are the whole of what either question needs.
CREATE INDEX sre_attributed ON send_recipient_events (org_id, received_at) WHERE manifest_id IS NOT NULL;

-- The volume rate's substrate: hand-overs inside a window.
--
-- Per **recipient**, not per manifest, because that is the grain the provider counts in
-- (send.counts_per_recipient = 1, cloudflare-email-sending.md) and it is the grain a runaway loop
-- produces. A manifest-level count would call one message to 400 people a single send.
--
-- send_counters is deliberately not the substrate even though it exists and is org-wide-and-daily. It
-- is a **maintained** cell -- an UPDATE ... SET handed_over = handed_over + 1 -- so it can drift from the
-- rows it claims to summarise, and its grain is a calendar day, which means a spike at 23:00 is
-- forgiven at midnight and a spike at 01:00 blocks the rest of the day. A window that slides is neither.
CREATE INDEX sr_handed_over ON send_recipients (org_id, submission_state_at)
  WHERE submission_state = 'handed_over';

-- A domain-wide send pause: the abuse breaker, latched, and the inverse of #64's asymmetry.
--
-- ## Which domain, and why the sending one
--
-- The domain of the envelope From -- this Node's own sending domain, derived from the address the
-- manifest was sealed with. That is the domain a Node can actually stop: pausing a *recipient* domain
-- would be a suppression list, and this product has none of its own (the transport keeps one; see
-- dispatch's `suppressed` state). Pausing a sending domain is the act that answers "this domain is
-- sending something it must not be sending, stop it now".
--
-- Stored lowercased and already punycoded, exactly as `addresses` stores an address's domain, so the
-- comparison in src/breakers.ts is an equality on a value neither side reformats. domainOf() in
-- src/policy.ts is the one parse, reused rather than repeated.
--
-- ## Ceremony to place, one administrator to lift -- the same principle as #64, pointing the other way
--
-- #64 made placing a legal hold easy and lifting it hard, because placing only ever preserves. Placing a
-- domain pause **stops a customer's mail**, so the safe direction reverses: placing takes dual control
-- through #61's approval machinery (subject_kind = 'domain_pause', the fifth) and a mandatory reason,
-- and a single org.admin may lift it -- because the harm of a wrongly-paused domain grows every minute
-- it stands, and an outage waiting for a second administrator to wake up is the failure mode that gets
-- limits raised until nothing ever fires.
--
-- ## placed_at is NULL until two people say so, and that is what makes a request not a pause
--
-- The row is written when somebody *asks*, in the same transaction as the approval (src/domain-pause.ts).
-- It confers nothing until the approval completes: a pause is in force exactly while
-- placed_at IS NOT NULL AND lifted_at IS NULL. A denied request leaves placed_at NULL for ever, and the
-- row stays as the record that somebody asked to stop a domain's mail and was refused -- the same shape
-- #63's supervised_grants.granted_at has, for the same reason.
CREATE TABLE domain_pauses (
  id      TEXT PRIMARY KEY,   -- dpz_<ulid>
  org_id  TEXT NOT NULL,

  -- The sending domain this stops. No foreign key, for the reason 0018 gives about matter_id: this
  -- schema declares none anywhere. There is no domains table either -- Email Routing only accepts
  -- addresses on domains in the customer's own account, so the domains that exist are the ones
  -- appearing in `addresses`, which is the same platform property #60 rests recipient_external on.
  domain  TEXT NOT NULL,

  -- **Mandatory, and non-empty.** The two people asked to approve a pause read this before they decide,
  -- which is why it lives here rather than only in the audit trail. NOT NULL is the half the database
  -- can hold; that the text is not blank or whitespace is enforced in src/domain-pause.ts, which refuses
  -- E_DOMAIN_PAUSE_REASON_REQUIRED -- SQLite cannot express the difference without a CHECK, and a
  -- mandatory field satisfied by a space is a mandatory field in name only.
  reason  TEXT NOT NULL,

  -- NULL until the approval completes. See the header: this is what separates a request from a pause.
  placed_at     TEXT,

  -- The lift. All three are written by one conditional UPDATE in src/domain-pause.ts, so a row with one
  -- and not the others is one no path in this Node produces.
  --
  -- lifted_reason is nullable **on purpose**, and it is the one asymmetry inside the asymmetry: #64
  -- requires a reason to lift a hold because lifting re-permits destruction. Lifting a pause re-permits
  -- *sending*, which is the direction this design is trying to make easy, so demanding a justification
  -- would put ceremony exactly where #66 decided there must be none. Who lifted it and when are still
  -- recorded, and the domain_pause.lifted audit entry is the account of it.
  lifted_at     TEXT,
  lifted_by     TEXT,
  lifted_reason TEXT
);

-- At most one pause in force per domain, and the read the breaker performs on every send.
--
-- UNIQUE and partial, which does two jobs with one B-tree: it is the index src/breakers.ts probes -- one
-- seek on (org_id, domain) per evaluation -- and it makes "two pauses in force on one domain" not
-- representable. Two would be two lifts needed to release one domain, and an administrator who lifted
-- the one they could see would believe they had restored the mail.
--
-- Asking again after a denial has a representation without relaxing this, exactly as apr_subject
-- requires: a denied request keeps placed_at NULL, so it is not in this index at all and a fresh row can
-- be written. That is the same move 0021 made by giving a lift its own hold_lifts row rather than keying
-- on the hold.
CREATE UNIQUE INDEX dpz_in_force ON domain_pauses (org_id, domain)
  WHERE placed_at IS NOT NULL AND lifted_at IS NULL;

-- Every pause a domain has ever had, in order, for doctor and for the lift path's refusals.
CREATE INDEX dpz_domain ON domain_pauses (org_id, domain);

-- ## approvals.mailbox_id becomes scope_id, which is the question 0021 deferred to this ticket
--
-- 0021 generalised an approval's target from a manifest to a (subject_kind, subject_id) pair and said,
-- on the mailbox_id column, exactly what it was leaving open:
--
--   "A future subject kind with no mailbox at all (a domain or routing change, blueprint 18) is a real
--    question and it is **not** answered here: a nullable mailbox_id would make 'who is eligible' a
--    question nothing validates ... That kind either names a mailbox or brings a second source for its
--    eligible set, and that is its ticket's work."
--
-- This is that ticket and that kind. A domain pause stops every mailbox sending from the domain, so no
-- single mailbox's approval.decide holders have authority over it, and naming one would be picking an
-- arbitrary mailbox to decide something about all of them.
--
-- So the fifth kind **brings a second source**: the eligible set for a domain pause is the org.admin
-- holders on the organization, resolved through teams and de-duplicated by the same query shape
-- decidersByMailbox uses (src/deciders.ts adminsOf). That is the relation this Node already requires for
-- every act that decides whether other people's mail may leave -- writing a policy, placing a hold --
-- and it is held on the **organization** object, which is why the column had to stop saying mailbox.
--
-- The column is renamed rather than left alone and stuffed with an org id. A column named mailbox_id
-- holding an organization id is the overclaiming name AGENTS.md calls a landmine: every reader after
-- today would join it to `mailboxes` and get nothing, and the join that returns no rows is the one
-- nobody notices. What the column always meant is **the object whose relation-holders are eligible to
-- decide** -- a mailbox for a send, a lift, a supervised read and an export; the organization for a
-- domain pause -- and scope_id is that sentence.
--
-- Which relation is read on which object is **not** a column: it is
-- SCOPE_OF: Record<ApprovalSubjectKind, ...> in src/approvals.ts, a total map keyed on the union, so a
-- sixth kind is a compile error there until it says where its approvers come from. A column would be a
-- second spelling of a fact the union already decides, and the failure mode is a row whose scope kind
-- disagrees with its subject kind.
--
-- No backfill: every existing row is a mailbox-scoped kind and keeps its value unchanged. A RENAME
-- COLUMN preserves data by definition, which is why this is one statement and not three.
ALTER TABLE approvals RENAME COLUMN mailbox_id TO scope_id;
