export type ManualSendEnrollment = {
  contact_id: string;
  campaign_id: string;
  current_step: number;
};

export type ManualSendCampaignStep = {
  id: string;
  campaign_id: string;
  step_number: number;
};

export function getManualSendProgressionKey(
  contactId: string,
  campaignId: string,
  campaignStepId: string,
) {
  return [contactId, campaignId, campaignStepId].join("|");
}

export function excludePreviouslyManuallySentEnrollments<
  T extends ManualSendEnrollment,
>(
  enrollments: T[],
  campaignSteps: ManualSendCampaignStep[],
  manuallySentProgressions: ReadonlySet<string>,
) {
  const stepsByCampaignAndNumber = new Map(
    campaignSteps.map((step) => [
      `${step.campaign_id}|${step.step_number}`,
      step,
    ]),
  );

  return enrollments.filter((enrollment) => {
    const step = stepsByCampaignAndNumber.get(
      `${enrollment.campaign_id}|${enrollment.current_step}`,
    );

    if (!step) return true;

    return !manuallySentProgressions.has(
      getManualSendProgressionKey(
        enrollment.contact_id,
        enrollment.campaign_id,
        step.id,
      ),
    );
  });
}
