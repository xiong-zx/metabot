import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { CardUpdateFailure, CardUpdateResult } from '../bridge/message-sender.interface.js';
import type { Logger } from '../utils/logger.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function stringOrNumber(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function responseHeader(response: Record<string, unknown> | undefined, name: string): string | undefined {
  const headers = response ? record(response.headers) : undefined;
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (typeof value === 'string') return value;
  const get = headers?.get;
  if (typeof get === 'function') {
    const result = get.call(headers, name);
    return typeof result === 'string' ? result : undefined;
  }
  return undefined;
}

/** Extract only stable, non-secret fields from an SDK/HTTP error. */
export function classifyFeishuDeliveryError(error: unknown): CardUpdateFailure {
  const root = record(error);
  const response = record(root?.response);
  const data = record(response?.data);
  const nestedError = record(data?.error);
  const httpStatus = numberValue(response?.status) ?? numberValue(root?.status);
  const providerCode = stringOrNumber(data?.code)
    ?? stringOrNumber(nestedError?.code)
    ?? stringOrNumber(root?.code);
  const providerMessage = typeof data?.msg === 'string'
    ? data.msg
    : typeof data?.message === 'string'
      ? data.message
      : undefined;
  const subcodeMatch = providerMessage?.match(/(?:ErrCode|error[_ ]?code)\s*[:=]\s*([\w-]+)/i);
  const providerSubcode = subcodeMatch?.[1];
  const requestId = [
    data?.request_id,
    data?.requestId,
    nestedError?.request_id,
    root?.requestId,
    responseHeader(response, 'x-request-id'),
    responseHeader(response, 'x-lark-request-id'),
    responseHeader(response, 'x-tt-logid'),
  ].find((value): value is string => typeof value === 'string' && value.length > 0);

  let category: CardUpdateFailure['category'] = 'unknown';
  let retryable = true;
  if (httpStatus === 401 || httpStatus === 403) {
    category = 'authentication';
    retryable = false;
  } else if (httpStatus === 404) {
    category = 'not_found';
    retryable = false;
  } else if (httpStatus === 429) {
    category = 'rate_limit';
  } else if (httpStatus === 408 || httpStatus === 425 || (httpStatus !== undefined && httpStatus >= 500)) {
    category = 'transient';
  } else if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    category = 'payload';
    retryable = false;
  }

  return {
    category,
    retryable,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerSubcode !== undefined ? { providerSubcode } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

export interface FeishuMessageSnapshot {
  messageId: string;
  chatId?: string;
  messageType?: string;
  content?: string;
}

export class MessageSender {
  private chatOwnerCache = new Map<string, { ownerId?: string; expiresAt: number }>();

  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  async sendCard(chatId: string, cardContent: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: cardContent,
          msg_type: 'interactive',
        },
      });

      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ chatId }, 'Failed to get message_id from send response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ chatId, ...classifyFeishuDeliveryError(err) }, 'Failed to send card');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardContent: string): Promise<CardUpdateResult> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardContent },
      });
      return { ok: true };
    } catch (err) {
      const failure = classifyFeishuDeliveryError(err);
      this.logger.error({ messageId, ...failure }, 'Failed to update card');
      return { ok: false, ...failure };
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, imageKey, savePath }, 'Image downloaded');
        return true;
      }
      this.logger.error({ messageId, imageKey }, 'Empty response when downloading image');
      return false;
    } catch (err) {
      this.logger.error({ messageId, imageKey, ...classifyFeishuDeliveryError(err) }, 'Failed to download image');
      return false;
    }
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, fileKey, savePath }, 'File downloaded');
        return true;
      }
      this.logger.error({ messageId, fileKey }, 'Empty response when downloading file');
      return false;
    } catch (err) {
      this.logger.error({ messageId, fileKey, ...classifyFeishuDeliveryError(err) }, 'Failed to download file');
      return false;
    }
  }

  async uploadImage(filePath: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      const imageKey = resp?.image_key;
      if (imageKey) {
        this.logger.info({ filePath, imageKey }, 'Image uploaded to Feishu');
      }
      return imageKey;
    } catch (err) {
      this.logger.error({ filePath, ...classifyFeishuDeliveryError(err) }, 'Failed to upload image');
      return undefined;
    }
  }

  async sendImage(chatId: string, imageKey: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ chatId, imageKey, ...classifyFeishuDeliveryError(err) }, 'Failed to send image');
      return false;
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    const imageKey = await this.uploadImage(filePath);
    if (!imageKey) return false;
    return this.sendImage(chatId, imageKey);
  }

  async uploadFile(filePath: string, fileName: string, fileType: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.file.create({
        data: {
          file_type: fileType as any,
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      const fileKey = resp?.file_key;
      if (fileKey) {
        this.logger.info({ filePath, fileKey, fileType }, 'File uploaded to Feishu');
      }
      return fileKey;
    } catch (err) {
      this.logger.error({ filePath, fileType, ...classifyFeishuDeliveryError(err) }, 'Failed to upload file');
      return undefined;
    }
  }

  async sendFile(chatId: string, fileKey: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'file',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ chatId, fileKey, ...classifyFeishuDeliveryError(err) }, 'Failed to send file');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string, fileType: string): Promise<boolean> {
    const fileKey = await this.uploadFile(filePath, fileName, fileType);
    if (!fileKey) return false;
    return this.sendFile(chatId, fileKey);
  }

  async sendAudio(chatId: string, fileKey: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'audio',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ chatId, fileKey, ...classifyFeishuDeliveryError(err) }, 'Failed to send audio');
      return false;
    }
  }

  async sendAudioFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    const fileKey = await this.uploadFile(filePath, fileName, 'opus');
    if (!fileKey) return false;
    return this.sendAudio(chatId, fileKey);
  }

  async getMessage(messageId: string): Promise<FeishuMessageSnapshot | undefined> {
    try {
      const resp = await this.client.im.v1.message.get({
        path: { message_id: messageId },
        params: { user_id_type: 'open_id' },
      });
      const item = resp?.data?.items?.find(candidate => candidate.message_id === messageId);
      if (!item?.message_id) {
        this.logger.warn({ messageId }, 'Referenced message lookup returned no message');
        return undefined;
      }
      return {
        messageId: item.message_id,
        chatId: item.chat_id,
        messageType: item.msg_type,
        content: item.body?.content,
      };
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to get referenced message');
      return undefined;
    }
  }

  async getChatMemberCount(chatId: string): Promise<number | undefined> {
    try {
      const resp: any = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const userCount = parseInt(resp?.data?.user_count, 10) || 0;
      const botCount = parseInt(resp?.data?.bot_count, 10) || 0;
      return userCount + botCount;
    } catch (err) {
      this.logger.error({ chatId, ...classifyFeishuDeliveryError(err) }, 'Failed to get chat member count');
      return undefined;
    }
  }

  async isChatOwner(chatId: string, userId: string): Promise<boolean | undefined> {
    const cached = this.chatOwnerCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.ownerId === userId;
    }

    try {
      const resp: any = await this.client.im.v1.chat.get({
        params: { user_id_type: 'open_id' },
        path: { chat_id: chatId },
      });
      const ownerId = resp?.data?.owner_id ?? resp?.owner_id;
      this.chatOwnerCache.set(chatId, {
        ownerId: typeof ownerId === 'string' ? ownerId : undefined,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
      return typeof ownerId === 'string' ? ownerId === userId : undefined;
    } catch (err) {
      this.logger.error({ chatId, userId, ...classifyFeishuDeliveryError(err) }, 'Failed to verify Feishu chat owner');
      return undefined;
    }
  }

  async sendText(chatId: string, text: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ chatId, ...classifyFeishuDeliveryError(err) }, 'Failed to send text');
      return false;
    }
  }
}
