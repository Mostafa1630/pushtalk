import { describe, expect, it } from "vitest";
import type { TranslationKey, TranslationValues } from "./i18n";
import { channelSchema, loginSchema, validateForm } from "./validation";

const messages: Partial<Record<TranslationKey, string>> = {
  username: "Username",
  password: "Password",
  channelName: "Channel name",
  channelDescription: "Description",
  validationRequired: "{field} is required.",
  validationMinLength: "{field} needs {count} characters.",
  validationMaxLength: "{field} allows {count} characters.",
  validationInvalid: "Invalid {field}.",
  usernameFormat: "Invalid username format.",
  channelNameFormat: "Invalid channel name format.",
};

function translate(
  key: TranslationKey,
  values: TranslationValues = {},
): string {
  return Object.entries(values).reduce(
    (text, [name, replacement]) =>
      text.replaceAll(`{${name}}`, String(replacement)),
    messages[key] ?? key,
  );
}

describe("Yup form validation", () => {
  it("returns localized username and password field errors", async () => {
    const errors = await validateForm(
      loginSchema,
      { username: "ab", password: "short" },
      translate,
    );

    expect(errors.username).toBe("Username needs 3 characters.");
    expect(errors.password).toBe("Password needs 8 characters.");
  });

  it("validates channel names and description length independently", async () => {
    const errors = await validateForm(
      channelSchema,
      { name: "Bad Name", description: "x".repeat(201) },
      translate,
    );

    expect(errors.name).toBe("Invalid channel name format.");
    expect(errors.description).toBe("Description allows 200 characters.");
  });

  it("accepts valid account and channel values", async () => {
    await expect(
      validateForm(
        loginSchema,
        { username: "alice_1", password: "password123" },
        translate,
      ),
    ).resolves.toEqual({});
    await expect(
      validateForm(
        channelSchema,
        { name: "team-alpha", description: "Voice team" },
        translate,
      ),
    ).resolves.toEqual({});
  });
});
