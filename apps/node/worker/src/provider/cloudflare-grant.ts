/**
 * The Node's Cloudflare surface, in one place for its importers (`routes/provider.ts`, `doctor/node.ts`).
 *
 * A barrel since 20 September 2026. The credential (`credential.ts`), the API calls (`cloudflare-api.ts`),
 * the account and zone resolution (`account-routing.ts`), and the provisioning acts (`sending-events.ts`,
 * `ownership.ts`, `provisioned.ts`) are separate modules; this file re-exports and reads nothing.
 * `test/node/provider-blast-radius.test.ts` keeps the set of importers closed.
 */
export {
  REQUIRED_PERMISSIONS, PROVIDER_NOTE, type Permission, type ProviderState, PROVIDER_STATES,
  type ProviderStatus, STATUS_COLUMNS, providerStatus, registerToken, forgetToken,
} from "./credential.ts";
export {
  cloudflareGet, cloudflarePost, cloudflarePut, cloudflareGetAll, accessTokenFor,
  type OperatorAuthority, operatorOf, withOperator,
} from "./cloudflare-api.ts";
export {
  type RoutingState, boundAccount, boundAccountFor, zoneFor, emailRoutingFor, emailRoutingState,
} from "./account-routing.ts";
export { type SendingDomainState, type DeliveryEventsState, deliveryEventsState, type SendingProposal, sendingProposalFor, onboardSending, type SubscriptionProposal, subscriptionProposalFor, subscribeDeliveryEvents } from "./sending-events.ts";
export { type OwnershipSource, type OwnershipFact, ownershipFacts } from "./ownership.ts";
export { type Provisioned, type ProvisionedAct, provisionedFacts } from "./provisioned.ts";
