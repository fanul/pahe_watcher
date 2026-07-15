export function getPublicDeadLinkReportConfig(runtime) {
  return {
    reportCommentTemplate: runtime.deadLinkReport.reportCommentTemplate,
  };
}

export function applyDeadLinkReportOverrides(runtime, patch) {
  if (patch.deadLinkReport) Object.assign(runtime.deadLinkReport, patch.deadLinkReport);
}

export function mergeDeadLinkReportOverrides(existing, patch) {
  return { ...(existing.deadLinkReport || {}), ...(patch.deadLinkReport || {}) };
}
