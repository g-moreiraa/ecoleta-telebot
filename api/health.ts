export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    tokenSet: !!process.env.TELEGRAM_TOKEN,
    predictUrlSet: !!process.env.PREDICT_URL,
  });
}
