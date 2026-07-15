export function populateDeadLinkReportSettings(form, cfg) {
  form.deadLinkReport_reportCommentTemplate.value = cfg.deadLinkReport.reportCommentTemplate;
}

export function serializeDeadLinkReportSettings(form) {
  return {
    reportCommentTemplate: form.deadLinkReport_reportCommentTemplate.value,
  };
}
