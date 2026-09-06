Please modify my existing audit.js only. Do not rewrite or simplify unrelated code.

GOAL:
When a teller submits a corrected closing cash count for the SAME branch/date/audit cycle, rerun the reconciliation using that corrected closing count.

If the corrected count now reconciles:
1. Mark that same discrepancy as resolved.
2. Remove it from the open discrepancy tracker.
3. Post:
   "✅ PHP resolved — corrected closing cash count now reconciles."
   (Use the actual currency instead of PHP when applicable.)
4. Do not carry that discrepancy into future audit reports.

IMPORTANT:
A clean result from a DIFFERENT day or DIFFERENT shift must NOT resolve an older discrepancy.

Replace the existing annotateFlags() function with this:

function annotateFlags(flagStore, branch, results, dateLabel, dryRun = false, cycleId = dateLabel) {
  const stillOpen = [];
  const resolved = [];

  for (const r of results) {
    const key = `${branch}|${r.ccy}`;
    const prior = flagStore.get(key);

    if (r.match) {
      // Only the SAME audit cycle may automatically resolve its own
      // discrepancy. A later shift/day that happens to balance must not
      // clear an older unresolved finding.
      if (prior && prior.cycleId === cycleId) {
        if (!dryRun) flagStore.delete(key);

        resolved.push({
          ccy: r.ccy,
          since: prior.firstFlaggedLabel,
          correctedCount: true
        });
      }

      continue;
    }

    if (prior) {
      stillOpen.push({
        ...r,
        since: prior.firstFlaggedLabel
      });
    } else {
      if (!dryRun) {
        flagStore.set(key, {
          diff: r.diff,
          firstFlaggedLabel: dateLabel,
          cycleId,
          missingFromOpening: r.missingFromOpening,
          missingFromClosing: r.missingFromClosing,
          expected: r.expected,
          actual: r.actual,
          openingAmount: r.openingAmount
        });
      }

      stillOpen.push({
        ...r,
        since: dryRun ? '(would be newly flagged)' : null
      });
    }
  }

  return { stillOpen, resolved };
}

Then, inside buildShiftAuditReport(), immediately after:

const dateLabel = (closingCount.timestamp || '').split(',')[0].trim();

add:

const cycleId = `${branchConfig.name}|shift|${dateLabel}|${windowLabel(closingCount)}`;

Then replace the annotateFlags call in buildShiftAuditReport() with:

const { stillOpen, resolved } = annotateFlags(
  SHIFT_AUDIT_FLAGS,
  branchConfig.name,
  results,
  dateLabel,
  dryRun,
  cycleId
);

In buildShiftAuditReport(), after displaying stillOpen discrepancies, add:

for (const r of resolved) {
  lines.push(
    `✅ ${r.ccy} resolved — corrected closing cash count now reconciles.`
  );
}

if (resolved.length) lines.push('');

Also update the clean-result condition.

Change:

if (stillOpen.length === 0) {

to:

if (stillOpen.length === 0 && resolved.length === 0) {

For the handover tracker, create a separate cycle ID so a handover cannot accidentally resolve a Shift Audit discrepancy.

Inside buildQuestionReport(), before calling annotateFlags(), add:

const cycleId = `${branchConfig.name}|handover|${dateLabel}|${windowText}`;

Then call:

const { stillOpen, resolved } = annotateFlags(
  HANDOVER_FLAGS,
  branchConfig.name,
  results,
  dateLabel,
  dryRun,
  cycleId
);

If resolved contains anything, display:

for (const r of resolved) {
  lines.push('');
  lines.push(
    `✅ ${r.ccy} resolved — corrected closing cash count now reconciles.`
  );
}

Do NOT combine SHIFT_AUDIT_FLAGS and HANDOVER_FLAGS.

Do NOT change reconcile.js.

After editing:
1. Run a syntax check on audit.js.
2. Show me the exact diff.
3. Do not deploy yet.
