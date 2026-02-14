export type PlaceCallInput = {
  to: string;
  script: string;
  callbackUrl: string;
};

export type PlaceCallOutput = {
  callId: string;
};

export interface CallProvider {
  placeCall(input: PlaceCallInput): Promise<PlaceCallOutput>;
}
