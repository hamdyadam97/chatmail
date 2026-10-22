/**
 * محمّل وحدة MLS الـWASM (أثر spike/mls — انظر crypto/wasm-pkg/README.md).
 *
 * نمط الـSpike المعتمد (§8.2): الغلاف لا يبقي Group حيًّا بين النداءات؛ كل
 * عملية تبني `SpikeClient` قصير العمر، تحمّل حالة المجموعة من المخزن
 * (IndexedDB عبر keystore)، تنفّذ، ثم تُعيد حفظ الحالة. لذلك لا نحتاج هنا
 * إلا تهيئة الـWASM مرة واحدة وتصدير صنف العميل.
 *
 * إعادة بناء الأثر: داخل WSL، `cd spikes/mls && npm run build:wasm`
 * (لا رابط C على ويندوز المضيف — docs/phase1/08 §8.1).
 */
import initWasm, { SpikeClient } from './wasm-pkg/mls_spike';

let initPromise: Promise<unknown> | null = null;

function assertEnvironment(): void {
  if (typeof WebAssembly === 'undefined') {
    throw new Error('متصفحك لا يدعم WebAssembly المطلوبة للتشفير الطرف-لطرف');
  }
  // wasm-bindgen الحديث يستخدم externref/BigInt — متوافرة في كل المتصفحات
  // الداعمة للـWASM الحديث؛ نتحقق تحسبًا لتشخيص أوضح.
  if (typeof BigInt === 'undefined') {
    throw new Error('متصفحك لا يدعم BigInt المطلوبة لوحدة التشفير');
  }
}

/** يهيّأ الـWASM مرة واحدة (آمن للاستدعاء المتكرر). */
export function initMlsWasm(): Promise<unknown> {
  assertEnvironment();
  initPromise ??= initWasm().catch((err) => {
    initPromise = null; // السماح بإعادة المحاولة بعد فشل أولي
    throw err;
  });
  return initPromise;
}

/** يعيد صنف SpikeClient بعد ضمان التهيئة. */
export async function getSpikeClientClass(): Promise<typeof SpikeClient> {
  await initMlsWasm();
  return SpikeClient;
}
