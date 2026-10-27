const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const { queryAuditLogs, queryAllForExport, buildExportCsv } = require('../services/auditService');

router.use(requireAuth, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const result = await queryAuditLogs({
      actor: req.query.actor,
      action: req.query.action,
      resourceType: req.query.resourceType,
      correlationId: req.query.correlationId,
      source: req.query.source,
      startDate: req.query.dateFrom,
      endDate: req.query.dateTo,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json(result);
  })
);

router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const filters = {
      actor: req.query.actor,
      action: req.query.action,
      resourceType: req.query.resourceType,
      correlationId: req.query.correlationId,
      source: req.query.source,
      startDate: req.query.dateFrom,
      endDate: req.query.dateTo,
    };

    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const rows = await queryAllForExport(filters);

    const ext = format === 'csv' ? 'csv' : 'json';
    const contentType =
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs.${ext}"`);

    if (format === 'csv') {
      res.send(buildExportCsv(rows));
    } else {
      res.send(JSON.stringify({ audit_logs: rows }, null, 2));
    }
  })
);

module.exports = router;
