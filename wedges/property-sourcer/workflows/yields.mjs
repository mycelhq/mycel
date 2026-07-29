// Deterministic yield math for a UK BTL deal. The agent must NOT do this in prose — an
// unverifiable yield is worse than no yield. Mirrors knowledge/sourcing-criteria.md exactly; if
// the criteria change, change them here too and the numbers stay honest.
//
// Founder code. Pure: no I/O, no clock, no randomness. Same inputs → same numbers, forever.

const round2 = (n) => Math.round(n * 100) / 100;

/** UK stamp duty for an additional (buy-to-let) property, 2026 bands + 3% surcharge. */
function stampDuty(price) {
  const bands = [
    [125_000, 0.0],
    [250_000, 0.02],
    [925_000, 0.05],
    [1_500_000, 0.10],
    [Infinity, 0.12],
  ];
  let tax = price * 0.03; // additional-property surcharge on the whole price
  let lower = 0;
  for (const [upper, rate] of bands) {
    if (price <= lower) break;
    tax += (Math.min(price, upper) - lower) * rate;
    lower = upper;
  }
  return Math.round(tax);
}

export default function yields(args) {
  const price = Number(args.price_gbp);
  const monthlyRent = Number(args.monthly_rent_gbp);
  if (!Number.isFinite(price) || price <= 0) throw new Error("price_gbp must be a positive number");
  if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) throw new Error("monthly_rent_gbp must be a positive number");

  const isFlat = args.property_type === "flat";
  const serviceCharge = Number(args.service_charge_gbp ?? 0);
  const groundRent = Number(args.ground_rent_gbp ?? 0);

  const annualRent = monthlyRent * 12;

  // Running costs, per the criteria doc: management 10%, maintenance 10%, insurance £300,
  // plus service charge + ground rent for flats.
  const management = annualRent * 0.10;
  const maintenance = annualRent * 0.10;
  const insurance = 300;
  const flatCosts = isFlat ? serviceCharge + groundRent : 0;
  const runningCosts = management + maintenance + insurance + flatCosts;

  // Purchase costs: SDLT (BTL surcharge) + legal £1,500 + survey £600 + any sourcing fee.
  const sdlt = stampDuty(price);
  const legal = 1_500;
  const survey = 600;
  const sourcingFee = Number(args.sourcing_fee_gbp ?? 0);
  const purchaseCosts = sdlt + legal + survey + sourcingFee;

  const grossYield = (annualRent / price) * 100;
  const netYield = ((annualRent - runningCosts) / (price + purchaseCosts)) * 100;

  const minNet = Number(args.min_net_yield_pct ?? 6.0);
  const clearsBox = netYield >= minNet;

  return {
    annual_rent_gbp: round2(annualRent),
    gross_yield_pct: round2(grossYield),
    net_yield_pct: round2(netYield),
    running_costs_gbp: round2(runningCosts),
    purchase_costs_gbp: round2(purchaseCosts),
    breakdown: {
      management_gbp: round2(management),
      maintenance_gbp: round2(maintenance),
      insurance_gbp: insurance,
      flat_costs_gbp: round2(flatCosts),
      sdlt_gbp: sdlt,
      legal_gbp: legal,
      survey_gbp: survey,
      sourcing_fee_gbp: sourcingFee,
    },
    min_net_yield_pct: minNet,
    clears_box: clearsBox,
    // The price at which this deal would exactly hit the buyer's minimum net yield.
    price_to_clear_box_gbp: clearsBox
      ? null
      : Math.floor(((annualRent - runningCosts) / (minNet / 100)) - purchaseCosts),
  };
}
