export const productCostTables = ['pos_products', 'pos_sale_lines'] as const;
export const productCostColumnSql = "INTEGER CHECK(cost_cents IS NULL OR (typeof(cost_cents)='integer' AND cost_cents BETWEEN 0 AND 1000000000))";

export type ProductMargin = {
  quantity: number;
  revenue_cents: number;
  cost_cents: number;
  profit_cents: number;
  missing_cost_quantity: number;
};

export function marginComplete(margin: ProductMargin) {
  return margin.missing_cost_quantity === 0;
}

/** Do not present unknown purchase costs as zero profit or free stock. */
export function marginKnown(margin: ProductMargin) {
  return !margin.quantity || margin.missing_cost_quantity < margin.quantity;
}
