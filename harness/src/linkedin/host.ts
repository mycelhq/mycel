// The kernel's implementation of @mycel/linkedin's host seams.
//
// The LinkedIn/Voyager core lives in packages/linkedin and knows nothing about the kernel. This
// file is where the kernel plugs itself in: the vault for sessions and proxy urls, the store-backed
// pacing engine (../pacing keeps the semantics — budgets, ramps, windows, multipliers), connection
// rows in the domain store, graph writes, and the GTM bookkeeping that turns synced inboxes and
// accepted invitations into cases and engagement counters.
//
// Every adapter resolves `getDomainStore()` lazily, per call — tests re-initialise the store and a
// host captured at import time would keep writing into the old one.
//
// Imported for its side effect by the re-export shims in this directory, so any kernel module that
// touches the LinkedIn core is guaranteed a wired host.
import { setLinkedInHost, bindJarPersist } from "@mycel/linkedin";
import { getDomainStore } from "../domain";
import { getSecret, setSecret, deleteSecret } from "../secrets";
import { assertSendAllowed, recordTouch, recordEngagement } from "../pacing";
import { captureUnsolicitedInbound } from "../gtm/inbound";
import { noteInboundReplies } from "../gtm/replies";
import { noteAcceptedInvitations } from "../gtm/acceptance";
import { gtmWedge } from "../gtm/stages";
import { judgeLead } from "@mycel/sourcing/lead-quality";

setLinkedInHost({
  /**
   * The pipeline's garbage collector, injected here because the rule is the PRODUCT's and is shared
   * with the outbound engine's own sourcing — `@mycel/linkedin` reads LinkedIn faithfully and does
   * not get an opinion about which rows a founder should see.
   */
  judgeLead,
  secrets: {
    get: (key) => getSecret(key),
    set: (key, value) => setSecret(key, value),
    delete: (key) => deleteSecret(key),
  },
  pacing: {
    assertSendAllowed: (connectionId, kind) => assertSendAllowed(getDomainStore(), connectionId, kind),
    recordTouch: async (connectionId, kind) => {
      await recordTouch(getDomainStore(), connectionId, kind);
    },
    recordEngagement: async (connectionId, delta) => {
      await recordEngagement(getDomainStore(), connectionId, delta);
    },
  },
  connections: {
    createConnection: (input) => getDomainStore().createConnection(input),
    getConnection: (id) => getDomainStore().getConnection(id),
    updateConnection: (id, patch) => getDomainStore().updateConnection(id, patch),
    deleteConnection: (id) => getDomainStore().deleteConnection(id),
  },
  records: {
    upsertRecord: (r) => getDomainStore().upsertRecord(r),
  },
  inbound: {
    noteInboundReplies: (conn, inbound) => noteInboundReplies(getDomainStore(), conn, inbound),
    captureUnsolicitedInbound: (conn, inbound) => captureUnsolicitedInbound(getDomainStore(), conn, inbound),
    noteAcceptedInvitations: (conn, observed) => noteAcceptedInvitations(getDomainStore(), conn, observed),
  },
  wedge: () => gtmWedge(),
  // Handed as the first argument to any pacing double installed via `_setPacing`, preserving the
  // (domain, connectionId, kind) shape the kernel's tests have always used.
  pacingContext: () => getDomainStore(),
});

bindJarPersist({
  get: (key) => getSecret(key),
  set: (key, value) => setSecret(key, value),
});
