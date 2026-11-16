// @ogmake/sdk — official Node/TypeScript client. Real implementation:
// createClient({apiKey?, baseUrl?, fetch?}) -> renderImage/renderHtml/listTemplates/
// getUsage/freeRender/signImageUrl/publicImageUrl/createBatch/getBatch/renderImageAsync/
// listWebhookDeliveries/autoImage, publicAutoUrl/signAutoImageUrl (auto mode), verifyWebhookSignature, plus the shared
// og:image snippet generator. See decisions-2026-09-22.md item 3.
export { OGMAKE_SDK_VERSION } from "./version";

export {
  createClient,
  DEFAULT_BASE_URL,
  publicAutoUrl,
  signAutoImageUrl,
  type AutoImageOptions,
  type AutoImageResult,
  type PublicAutoUrlOptions,
  type SignAutoImageUrlOptions,
  type CreateClientOptions,
  type FetchLike,
  type OgmakeClient,
  type ImageParamValue,
  type RenderImageOptions,
  type RenderImageResult,
  type RenderHtmlOptions,
  type RenderHtmlResult,
  type TemplateDescriptor,
  type ListTemplatesResult,
  type UsageResult,
  type FreeRenderOptions,
  type FreeRenderResult,
  type CheckFinding,
  type CheckLinkPreviewResult,
  type SignImageUrlOptions,
  type RenderImageAsyncOptions,
  type RenderImageAsyncResult,
  type BatchItem,
  type CreateBatchOptions,
  type CreateBatchResult,
  type BatchItemResult,
  type BatchStatusResult,
  type WebhookDelivery,
  type WebhookDeliverySummary,
  type ListWebhookDeliveriesOptions,
} from "./client";

export {
  verifyWebhookSignature,
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  type VerifyWebhookOptions,
} from "./webhook";

export {
  OgmakeApiError,
  OgmakeNetworkError,
  OgmakeRedirectError,
  type OgmakeErrorDetail,
} from "./errors";

export {
  ogSnippet,
  autoSnippet,
  DEFAULT_AUTO_URL_PLACEHOLDER,
  type AutoSnippetOptions,
  isSnippetFramework,
  SNIPPET_FRAMEWORKS,
  type SnippetFramework,
} from "./snippets";
