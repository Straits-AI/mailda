/**
 * The Node's own Cloudflare grant (#162 L1, ADR 42), and everything the Node reads and writes with it.
 *
 * Split on 20 September 2026 so each part changes for one reason. This file is the seam every importer
 * uses; the parts are:
 *
 * - `grant-oauth.ts`: the ceremony, the redirect, the exchange, the refresh, and the states an operator can
 *   be in while doing it.
 * - `cloudflare-api.ts`: the measured endpoints, the token, and the authenticated calls made with it.
 * - `account-routing.ts`: the bound account, the zone walk, and Email Routing's state.
 * - `sending-events.ts`: sending domains, the delivery-events subscription, the queue and its consumer.
 * - `ownership.ts`: the facts #165 asks for about who owns what.
 */

export { REQUIRED_SCOPES, REQUIRED_SCOPE_NAMES, type ProviderState, PROVIDER_STATES, type ProviderStatus, STATUS_COLUMNS, providerStatus, ceremony, OAUTH_CLIENTS_PERMISSION, OAUTH_CLIENTS_PERMISSION_ID, tokenTemplateUrl, createClientThroughApi, type ClientRegistration, registerClient, MIN_STATE_LENGTH, beginAuthorization, type ConsentOutcome, completeAuthorization, reportUnselectable } from "./grant-oauth.ts";
export { CLOUDFLARE_OAUTH, cloudflareGet, cloudflarePost, cloudflarePatch, cloudflarePut, cloudflareGetAll } from "./cloudflare-api.ts";
export { resolveAccount, type RoutingState, boundAccountFor, zoneFor, emailRoutingFor, emailRoutingState } from "./account-routing.ts";
export { type SendingDomainState, type DeliveryEventsState, deliveryEventsState, type SendingProposal, sendingProposalFor, onboardSending, type SubscriptionProposal, subscriptionProposalFor, subscribeDeliveryEvents } from "./sending-events.ts";
export { type OwnershipSource, type OwnershipFact, ownershipFacts } from "./ownership.ts";
