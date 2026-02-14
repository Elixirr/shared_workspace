import { EmailProvider, EmailSendInput, EmailSendOutput } from "../interfaces/email";

class FakeEmailProvider implements EmailProvider {
  async sendEmail(input: EmailSendInput): Promise<EmailSendOutput> {
    const fakeMessageId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    console.log("[fake-email-provider] to=%s subject=%s messageId=%s", input.to, input.subject, fakeMessageId);
    return { messageId: fakeMessageId };
  }
}

class RealEmailProvider implements EmailProvider {
  async sendEmail(_input: EmailSendInput): Promise<EmailSendOutput> {
    // TODO: add SendGrid/Mailgun adapters behind ENV=production.
    throw new Error("Real email provider not implemented yet");
  }
}

export const resolveEmailProvider = (): EmailProvider => {
  const env = (process.env.ENV ?? "development").toLowerCase();
  if (env === "production") {
    return new RealEmailProvider();
  }
  return new FakeEmailProvider();
};
