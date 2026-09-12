# @mycel/sourcing

Azure Maps transport and the identity rules a sourced business is keyed by.

## Why it exists

`growth/` harvests agencies with Azure Maps nearby-by-category. The product kernel finds whoever a founder sells to — bakeries, clinics, trades — and needs the same phone-carrying POI hop, plus geocode so an audience's place string can become a point.

Two copies of that client is how a Maps quirk gets fixed on one side and silently stays wrong on the other. Harvest itself (tiling, the 40-credit budget, promote) stays in `growth/`. This package is the transport and the identity functions both sides import.

## What is in here

| module | answers |
| --- | --- |
| `azure-maps` | nearby-by-category (agency wedges), geocode, POI-by-query (arbitrary trades). Injectable `fetch`. The phone is free. |
| `identity` | `ownDomain` / `registrableDomain` / shared hosts, US E.164, `businessKey`. A Wix URL is not a company. |

## What does not belong here

The harvest loop, Serper dorks, footer-credit crawl, site promote, or any graph write. Those are app work. A GTM find that needs a bakery near Bristol geocodes, searches POI, then joins onto people itself.
