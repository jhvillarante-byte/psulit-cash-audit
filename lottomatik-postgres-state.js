class PostgresDeliveryState {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new Error('A PostgreSQL pool is required.');
    this.pool = pool;
  }

  async health() {
    const result = await this.pool.query(`
      SELECT to_regclass('public.lottomatik_summary_deliveries') AS table_name
    `);
    return { connected: true, tableExists: Boolean(result.rows[0] && result.rows[0].table_name) };
  }

  async ensure(key, metadata = {}) {
    await this.pool.query(`
      INSERT INTO public.lottomatik_summary_deliveries (
        report_key, branch, opening_ref, closing_ref,
        opening_slack_ts, closing_slack_ts, workbook_sha256, report_sha256
      ) VALUES ($1, 'Alphaland', $2, $3, $4, $5, $6, $7)
      ON CONFLICT (report_key) DO NOTHING
    `, [key, metadata.openingRef, metadata.closingRef,
      metadata.openingSlackTs, metadata.closingSlackTs,
      metadata.workbookDigest, metadata.reportDigest]);
  }

  async get(key) {
    const result = await this.pool.query(`
      SELECT slack_status, slack_message_ts, slack_posted_at,
             telegram_status, telegram_message_ids, telegram_posted_at, last_error
      FROM public.lottomatik_summary_deliveries WHERE report_key = $1
    `, [key]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      slack: { status: row.slack_status, ...(row.slack_message_ts ? { ts: row.slack_message_ts } : {}) },
      telegram: { status: row.telegram_status, ...(row.telegram_message_ids ? { message_id: row.telegram_message_ids } : {}) },
      lastError: row.last_error || null
    };
  }

  async claim(key, destination) {
    const column = destinationColumn(destination);
    const result = await this.pool.query(`
      UPDATE public.lottomatik_summary_deliveries
      SET ${column}_status = 'pending', ${column}_last_attempt_at = now(),
          last_error = NULL, updated_at = now()
      WHERE report_key = $1 AND ${column}_status IN ('not_started', 'failed')
      RETURNING report_key
    `, [key]);
    return result.rowCount === 1;
  }

  async complete(key, destination, receipt = {}) {
    const column = destinationColumn(destination);
    const receiptColumn = destination === 'slack' ? 'slack_message_ts' : 'telegram_message_ids';
    const receiptValue = destination === 'slack' ? receipt.ts : receipt.message_id;
    await this.pool.query(`
      UPDATE public.lottomatik_summary_deliveries
      SET ${column}_status = 'posted', ${receiptColumn} = $2,
          ${column}_posted_at = now(), last_error = NULL, updated_at = now()
      WHERE report_key = $1
    `, [key, receiptValue ? String(receiptValue) : null]);
  }

  async fail(key, destination, error) {
    const column = destinationColumn(destination);
    await this.pool.query(`
      UPDATE public.lottomatik_summary_deliveries
      SET ${column}_status = 'failed', last_error = $2, updated_at = now()
      WHERE report_key = $1
    `, [key, String(error && error.message || error || 'Delivery failed').slice(0, 300)]);
  }
}

function destinationColumn(destination) {
  if (!['slack', 'telegram'].includes(destination)) throw new Error('Invalid delivery destination.');
  return destination;
}

module.exports = { PostgresDeliveryState };
