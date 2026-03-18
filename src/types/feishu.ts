export type TenantAccessTokenResponse = {
  code: number;
  expire: number;
  msg: string;
  tenant_access_token: string;
};

export type FeishuUrlVerification = {
  type: "url_verification";
  challenge: string;
  token?: string;
};

export type FeishuEventHeader = {
  app_id?: string;
  create_time?: string;
  event_id: string;
  event_type: string;
  tenant_key?: string;
  token?: string;
};

export type FeishuSenderId = {
  open_id?: string;
  union_id?: string;
  user_id?: string;
};

export type FeishuSender = {
  sender_id?: FeishuSenderId;
  sender_type?: "user" | "app";
  tenant_key?: string;
};

export type FeishuMention = {
  key?: string;
  name?: string;
  id?: FeishuSenderId;
};

export type FeishuMessage = {
  chat_id: string;
  chat_type?: "p2p" | "group";
  content: string;
  mentions?: FeishuMention[];
  message_id: string;
  message_type: string;
};

export type FeishuMessageEvent = {
  message: FeishuMessage;
  sender?: FeishuSender;
};

export type FeishuEventPayload = {
  schema?: string;
  header: FeishuEventHeader;
  event: FeishuMessageEvent;
};

export type FeishuWebhookPayload =
  | FeishuUrlVerification
  | FeishuEventPayload
  | {
      encrypt: string;
    };