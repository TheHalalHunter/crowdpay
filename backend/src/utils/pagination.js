/**
 * Parse and validate pagination parameters from query string.
 *
 * @param {object}  query              Express req.query
 * @param {number}  [defaults.limit=20]  Default page size
 * @param {number}  [defaults.max=100]   Hard upper-bound
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(query = {}, { limit: defaultLimit = 20, max: maxLimit = 100 } = {}) {
  const q = query || {};
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  return { limit, offset };
}

/**
 * Execute a data query together with a COUNT(*) query sharing the same
 * WHERE clause and parameters, then return the standard paginated envelope.
 *
 * @param {object}  db               The database pool / client
 * @param {string}  countSql         COUNT(*) query (must return a single `total` column)
 * @param {string}  dataSql          Data query with LIMIT $N OFFSET $N+1 appended
 * @param {Array}   baseParams       Bind parameters for the shared WHERE clause
 * @param {number}  limit            Page size
 * @param {number}  offset           Offset
 * @returns {Promise<{ data: Array, total: number, limit: number, offset: number }>}
 */
async function paginatedResponse(db, countSql, dataSql, baseParams, limit, offset) {
  const countResult = await db.query(countSql, baseParams);
  const total = parseInt(countResult.rows[0]?.total ?? countResult.rows[0]?.count ?? '0', 10);

  const dataResult = await db.query(dataSql, [...baseParams, limit, offset]);
  return { data: dataResult.rows, total, limit, offset };
}

module.exports = { parsePagination, paginatedResponse };
