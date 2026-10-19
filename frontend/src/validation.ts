import * as yup from "yup";
import type { TranslationKey, TranslationValues } from "./i18n";

type Translate = (key: TranslationKey, values?: TranslationValues) => string;
type YupSchema = {
  validate: (
    value: unknown,
    options?: { abortEarly?: boolean }
  ) => Promise<unknown>;
};
// username =  mostafa@gmail.com
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
// const USERNAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

const username = yup
  .string()
  .trim()
  .required()
  .min(3)
  .max(32)
  .matches(USERNAME_PATTERN, { excludeEmptyString: true });

const password = yup.string().required().min(8).max(72);

export const loginSchema = yup.object({ username, password });
export const registerSchema = yup.object({ username, password });
export const profileSchema = yup.object({ username });
export const passwordChangeSchema = yup.object({
  currentPassword: yup.string().required().min(8).max(72),
  newPassword: yup
    .string()
    .required()
    .min(8)
    .max(72)
    .notOneOf([yup.ref("currentPassword")]),
  confirmPassword: yup
    .string()
    .required()
    .oneOf([yup.ref("newPassword")]),
});
export const channelSchema = yup.object({
  name: yup
    .string()
    .trim()
    .required()
    .min(2)
    .max(64)
    .matches(CHANNEL_NAME_PATTERN, { excludeEmptyString: true }),
  description: yup.string().trim().max(200).defined(),
});

function fieldLabel(field: string, translate: Translate): string {
  switch (field) {
    case "username":
      return translate("username");
    case "password":
      return translate("password");
    case "currentPassword":
      return translate("currentPassword");
    case "newPassword":
      return translate("newPassword");
    case "confirmPassword":
      return translate("confirmNewPassword");
    case "name":
      return translate("channelName");
    case "description":
      return translate("channelDescription");
    default:
      return field;
  }
}

function formatIssue(issue: yup.ValidationError, translate: Translate): string {
  const field = issue.path ?? "field";
  const label = fieldLabel(field, translate);

  if (issue.type === "required") {
    return translate("validationRequired", { field: label });
  }
  if (issue.type === "min") {
    const minimum = Number(issue.params?.min ?? 0);
    return translate("validationMinLength", { field: label, count: minimum });
  }
  if (issue.type === "max") {
    const maximum = Number(issue.params?.max ?? 0);
    return translate("validationMaxLength", { field: label, count: maximum });
  }
  if (issue.type === "matches") {
    return translate(field === "name" ? "channelNameFormat" : "usernameFormat");
  }
  if (issue.type === "oneOf") return translate("passwordConfirmationMismatch");
  if (issue.type === "notOneOf") return translate("passwordMustDiffer");
  return translate("validationInvalid", { field: label });
}

export async function validateForm(
  schema: YupSchema,
  values: Record<string, unknown>,
  translate: Translate
): Promise<Record<string, string>> {
  try {
    await schema.validate(values, { abortEarly: false });
    return {};
  } catch (error) {
    if (!(error instanceof yup.ValidationError)) throw error;
    const issues = error.inner.length > 0 ? error.inner : [error];
    const fieldErrors: Record<string, string> = {};
    for (const issue of issues) {
      if (issue.path && !fieldErrors[issue.path]) {
        fieldErrors[issue.path] = formatIssue(issue, translate);
      }
    }
    return fieldErrors;
  }
}
