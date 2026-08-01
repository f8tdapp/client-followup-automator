export function getEnrollmentConfirmationMessage(count: number) {
  return count > 25
    ? `You are about to enrol exactly ${count} eligible contacts. This is a large enrolment. Continue?`
    : `Enrol exactly ${count} eligible contact${count === 1 ? "" : "s"}?`;
}

export function shouldProceedWithEnrollment(
  count: number,
  confirm: (message: string) => boolean,
) {
  return count > 0 && confirm(getEnrollmentConfirmationMessage(count));
}
