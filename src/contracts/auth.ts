import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common.js';

/** Global role. Admins see every project without being a member of any. */
export const UserRoleSchema = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRoleSchema>;

/** Role inside one project. `maintainer` may write and start agent jobs. */
export const ProjectMemberRoleSchema = z.enum(['viewer', 'maintainer']);
export type ProjectMemberRole = z.infer<typeof ProjectMemberRoleSchema>;

/**
 * A user as the API returns it. There is no password field in either direction
 * on this shape: it is set at creation and changed through its own endpoint.
 */
export const AccountSchema = z.object({
  id: IdSchema,
  email: z.email(),
  name: z.string().min(1),
  role: UserRoleSchema,
  isActive: z.boolean(),
  lastLoginAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type Account = z.infer<typeof AccountSchema>;

export const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type Login = z.infer<typeof LoginSchema>;

/** The session cookie carries the credential; the body is only the profile. */
export const LoginResultSchema = z.object({
  user: AccountSchema,
  expiresAt: IsoDateSchema,
});
export type LoginResult = z.infer<typeof LoginResultSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(200),
});
export type ChangePassword = z.infer<typeof ChangePasswordSchema>;

export const CreateUserSchema = z.object({
  email: z.email().max(320),
  name: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
  role: UserRoleSchema.default('member'),
});
export type CreateUser = z.infer<typeof CreateUserSchema>;

/** Every field optional: the endpoint patches whichever are sent. */
export const UpdateUserSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  role: UserRoleSchema.optional(),
  isActive: z.boolean().optional(),
  /** Administrative reset. The user's own change goes through /auth/password. */
  password: z.string().min(12).max(200).optional(),
});
export type UpdateUser = z.infer<typeof UpdateUserSchema>;

export const ProjectMemberSchema = z.object({
  userId: IdSchema,
  email: z.email(),
  name: z.string(),
  role: ProjectMemberRoleSchema,
  isActive: z.boolean(),
  addedAt: IsoDateSchema,
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

/** Grant or change one membership. Sending it twice is not an error. */
export const SetProjectMemberSchema = z.object({
  userId: IdSchema,
  role: ProjectMemberRoleSchema.default('viewer'),
});
export type SetProjectMember = z.infer<typeof SetProjectMemberSchema>;

export const ProjectTokenSchema = z.object({
  id: IdSchema,
  name: z.string(),
  /** First characters of the secret, enough to recognise it in a pipeline. */
  prefix: z.string(),
  lastUsedAt: IsoDateSchema.nullable(),
  revokedAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type ProjectToken = z.infer<typeof ProjectTokenSchema>;

export const CreateProjectTokenSchema = z.object({
  name: z.string().min(1).max(200),
});
export type CreateProjectToken = z.infer<typeof CreateProjectTokenSchema>;

/**
 * The only response that ever carries the secret. It is not stored in a
 * recoverable form, so a lost token is replaced rather than looked up.
 */
export const CreatedProjectTokenSchema = ProjectTokenSchema.extend({
  token: z.string(),
});
export type CreatedProjectToken = z.infer<typeof CreatedProjectTokenSchema>;
