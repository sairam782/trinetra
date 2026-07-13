export function getAlibabaDeploymentProof(env = process.env) {
  return {
    provider: "Alibaba Cloud",
    computeTarget: env.ALIBABA_COMPUTE_TARGET || "ECS or Function Compute",
    databaseTarget: env.ALIBABA_DATABASE_TARGET || "RDS for PostgreSQL or PolarDB",
    modelStudioEndpoint: env.QWEN_API_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
    region: env.ALIBABA_CLOUD_REGION || "us-west-1",
    proof: "This module is the Alibaba Cloud integration seam for deployment metadata, Qwen Model Studio config, and managed database targets.",
    requiredEnv: [
      "QWEN_API_KEY or DASHSCOPE_API_KEY",
      "QWEN_API_BASE_URL",
      "ALIBABA_CLOUD_REGION",
      "ALIBABA_CLOUD_ACCESS_KEY_ID",
      "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
      "ALIBABA_RDS_POSTGRES_URL"
    ]
  };
}
