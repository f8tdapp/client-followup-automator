export type RepairableCampaign = { id: string };

export type RepairableCampaignStep = {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  status: string;
};

export type CampaignStepRepair = Omit<RepairableCampaignStep, "id"> & {
  updated_at: string;
};

// Migration history currently constrains persisted campaign steps to 1-3.
// Later-step runtime logic is future-ready, but production Email 4+ requires a
// separately reviewed schema migration and is not currently UI-configurable.
export function planCampaignStepRepairs(
  campaigns: RepairableCampaign[],
  existingSteps: RepairableCampaignStep[],
  updatedAt: string,
): CampaignStepRepair[] {
  return campaigns.flatMap((campaign) => {
    const campaignSteps = existingSteps.filter(
      (step) => step.campaign_id === campaign.id,
    );
    const existingNumbers = new Set(
      campaignSteps.map((step) => step.step_number),
    );
    const repairable = campaignSteps
      .filter((step) => step.step_number >= 1 && step.step_number <= 3)
      .filter((step) => step.status === "active")
      .filter(shouldRepairDefaultCampaignStep)
      .map((step) => ({
        campaign_id: campaign.id,
        ...getDefaultCampaignStep(step.step_number),
        updated_at: updatedAt,
      }));
    const missing = [1, 2, 3]
      .filter((stepNumber) => !existingNumbers.has(stepNumber))
      .map((stepNumber) => ({
        campaign_id: campaign.id,
        ...getDefaultCampaignStep(stepNumber),
        updated_at: updatedAt,
      }));

    return [...repairable, ...missing];
  });
}

export function mergeCampaignSteps<T extends RepairableCampaignStep>(
  existingSteps: T[],
  repairedSteps: T[],
) {
  const repairedKeys = new Set(
    repairedSteps.map((step) => `${step.campaign_id}:${step.step_number}`),
  );
  return [
    ...existingSteps.filter(
      (step) => !repairedKeys.has(`${step.campaign_id}:${step.step_number}`),
    ),
    ...repairedSteps,
  ];
}

export function createVirtualRepairedSteps(
  existingSteps: RepairableCampaignStep[],
  repairs: CampaignStepRepair[],
): RepairableCampaignStep[] {
  const existingByKey = new Map(
    existingSteps.map((step) => [
      `${step.campaign_id}:${step.step_number}`,
      step,
    ]),
  );
  return repairs.map((repair) => {
    const key = `${repair.campaign_id}:${repair.step_number}`;
    return {
      id:
        existingByKey.get(key)?.id ??
        `forecast-virtual-step:${repair.campaign_id}:${repair.step_number}`,
      campaign_id: repair.campaign_id,
      step_number: repair.step_number,
      delay_days: repair.delay_days,
      subject_template: repair.subject_template,
      body_template: repair.body_template,
      status: repair.status,
    };
  });
}

export function getDefaultCampaignStep(stepNumber: number) {
  if (![1, 2, 3].includes(stepNumber)) {
    throw new RangeError(
      `Default campaign copy is only defined for starter steps 1-3; received ${stepNumber}.`,
    );
  }
  if (stepNumber === 1) {
    return {
      step_number: 1,
      delay_days: 0,
      subject_template: "Quick introduction",
      body_template:
        "Hi {first_name},\n\nI just wanted to introduce myself. We help real estate agents with listing photography, video, drone, and marketing content.\n\nIf you ever need help with an upcoming listing, I'd be happy to help.\n\nBest,\nTJ Muldoon",
      status: "active",
    };
  }
  if (stepNumber === 2) {
    return {
      step_number: 2,
      delay_days: 14,
      subject_template: "Just checking in",
      body_template:
        "Hi {first_name},\n\nJust checking back in to see if you have any upcoming listings or marketing needs.\n\nWe can help with photography, video, drone, and listing media when something comes up.\n\nBest,\nTJ Muldoon",
      status: "active",
    };
  }
  return {
    step_number: 3,
    delay_days: 30,
    subject_template: "Should I close the loop?",
    body_template:
      "Hi {first_name},\n\nI didn't want to keep bothering you, so I'll make this my last quick follow-up.\n\nIf you ever need listing photography, video, drone, or marketing support, I'd be happy to help.\n\nBest,\nTJ Muldoon",
    status: "active",
  };
}

function shouldRepairDefaultCampaignStep(step: RepairableCampaignStep) {
  return (
    !step.body_template.trim() ||
    !step.subject_template.trim() ||
    step.subject_template.startsWith(`Email ${step.step_number}:`) ||
    isObviousStarterCopyPlaceholder(step.subject_template) ||
    isObviousStarterCopyPlaceholder(step.body_template)
  );
}

function isObviousStarterCopyPlaceholder(value: string) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "no body copy yet" ||
    normalized.includes("tj did you get this") ||
    normalized.includes("lorem ipsum") ||
    normalized === "test" ||
    normalized === "asdf"
  );
}
