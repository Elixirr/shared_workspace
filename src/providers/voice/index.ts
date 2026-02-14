import { CallProvider, PlaceCallInput, PlaceCallOutput } from "../interfaces/voice";

class FakeCallProvider implements CallProvider {
  async placeCall(input: PlaceCallInput): Promise<PlaceCallOutput> {
    const callId = `fake-call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    console.log(
      "[fake-call-provider] to=%s callback=%s callId=%s script=%s",
      input.to,
      input.callbackUrl,
      callId,
      input.script
    );
    return { callId };
  }
}

class RealCallProvider implements CallProvider {
  async placeCall(_input: PlaceCallInput): Promise<PlaceCallOutput> {
    // TODO: add Twilio/VAPI adapters behind ENV=production.
    throw new Error("Real call provider not implemented yet");
  }
}

export const resolveCallProvider = (): CallProvider => {
  const env = (process.env.ENV ?? "development").toLowerCase();
  if (env === "production") {
    return new RealCallProvider();
  }
  return new FakeCallProvider();
};
