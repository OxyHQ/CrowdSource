import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';

/** Temporary role identity on ECS and authenticated development/SSO hosts. */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
