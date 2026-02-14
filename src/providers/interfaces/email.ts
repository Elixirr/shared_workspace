export type EmailSendInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
};

export type EmailSendOutput = {
  messageId: string;
};

export interface EmailProvider {
  sendEmail(input: EmailSendInput): Promise<EmailSendOutput>;
}
