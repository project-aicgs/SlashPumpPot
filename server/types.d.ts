export type TokenEventItem = {
  type: "TOKEN_EVENT";
  events: {
    token: Array<{
      mint: string;
      amount: string; // u64 as string
      fromUserAccount?: string;
      toUserAccount?: string;
    }>;
  };
};

