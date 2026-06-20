import { gql } from "apollo-server-express";

export const typeDefs = gql`
  scalar DateTime
  scalar JSON

  type ApexTeamMember {
    id: Int!
    UserName: String!
    displayName: String
    role: String!
  }

  type ApexAuthPayload {
    token: String!
    member: ApexTeamMember!
  }

  type ApexDashboardSummary {
    pendingSetupPayments: Int!
    pendingQuarterlyPayments: Int!
    pendingYearlyPayments: Int!
    unreadFeedback: Int!
    suspendedTenants: Int!
    bannedTenants: Int!
    setupPendingTenants: Int!
    billingHoldTenants: Int!
    graceOrExpiredTenants: Int!
    trialsEndingSoon: Int!
    totalTenants: Int!
    totalUsers: Int!
    disabledUsers: Int!
    pendingModuleRequests: Int!
    tenantsByBusinessType: [BusinessTypeCount!]!
  }

  type SignupPipelineRow {
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String
    ownerUserName: String!
    setupFeeETB: Int!
    paymentTransactionRef: String
    paymentChannel: String
    registeredAt: DateTime!
    pendingSetupPaymentId: Int
  }

  type BusinessTypeCount {
    businessType: String!
    label: String!
    count: Int!
  }

  type TenantUserMonitoringRow {
    id: Int!
    userName: String!
    role: String!
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String!
    loginDisabled: Boolean!
    loginDisabledReason: String
    createdAt: DateTime
  }

  type TenantOperationalSnapshot {
    staffCount: Int!
    ordersToday: Int!
    openOrders: Int!
    pendingPurchaseRequests: Int!
    pendingStockOutRequests: Int!
    pendingItemRegistrations: Int!
  }

  type ApexAuditLogRow {
    id: Int!
    action: String!
    targetTinNumber: String
    targetUserId: Int
    reason: String
    apexMemberName: String
    createdAt: DateTime!
  }

  type ModuleChangeRequestRow {
    id: Int!
    tinNumber: String!
    hotelDisplayName: String!
    status: String!
    requestedBySide: String!
    requestNote: String
    requestedModules: JSON
    createdAt: DateTime!
  }

  type TenantListItem {
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String
    accountStatus: String!
    subscriptionStatus: String!
    setupFeeApproved: Boolean!
    setupFeeETB: Int!
    quarterlyFeeETB: Int!
    ownerUserName: String!
    createdAt: DateTime
    billingHold: Boolean!
    isIllustrationTenant: Boolean!
    unreadFeedback: Int!
  }

  type TenantUserRow {
    id: Int!
    UserName: String!
    Role: String!
    loginDisabled: Boolean!
    loginDisabledReason: String
    createdAt: DateTime
  }

  type TenantPaymentRow {
    id: Int!
    tinNumber: String!
    paymentKind: String!
    amountETB: Int!
    paymentChannel: String!
    transactionRef: String!
    status: String!
    submittedAt: DateTime!
    approvedAt: DateTime
    rejectedAt: DateTime
    rejectionReason: String
    quarterNumber: Int
    hotelDisplayName: String
  }

  type PricingRuleRow {
    id: Int!
    businessType: String!
    modulesKey: String!
    modules: JSON!
    setupFeeETB: Int!
    quarterlyFeeETB: Int!
    description: String
    isActive: Boolean!
    sortOrder: Int!
    updatedAt: DateTime!
  }

  type TenantDetail {
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String
    logoUrl: String
    accountStatus: String!
    subscriptionStatus: String!
    modules: JSON
    setupFeeETB: Int!
    quarterlyFeeETB: Int!
    suggestedSetupFeeETB: Int!
    suggestedQuarterlyFeeETB: Int!
    feesManuallySet: Boolean!
    pricingRuleId: Int
    feesMatchCatalog: Boolean!
    setupFeeApproved: Boolean!
    subscriptionPaymentApproved: Boolean!
    subscriptionPaidUntil: DateTime
    paidQuartersCount: Int!
    billingHold: Boolean!
    billingStartedAt: DateTime
    isIllustrationTenant: Boolean!
    freeTrialEndsAt: DateTime
    billingNotes: String
    paymentChannel: String
    paymentTransactionRef: String
    ownerUserName: String!
    suspendedReason: String
    bannedReason: String
    users: [TenantUserRow!]!
    recentPayments: [TenantPaymentRow!]!
    operationalSnapshot: TenantOperationalSnapshot!
  }

  type FeedbackMessageRow {
    id: Int!
    threadId: Int!
    senderSide: String!
    tenantUserName: String
    tenantRole: String
    apexDisplayName: String
    body: String!
    imageUrl: String
    readByApex: Boolean!
    readByTenant: Boolean!
    createdAt: DateTime!
  }

  type FeedbackThreadRow {
    id: Int!
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String
    status: String!
    unreadFromTenant: Int!
    updatedAt: DateTime!
    lastMessage: FeedbackMessageRow
  }

  """Every property on HotCol — with thread info when a chat exists."""
  type FeedbackDirectoryRow {
    tinNumber: String!
    hotelDisplayName: String!
    threadId: Int
    chatStatus: String!
    unreadFromTenant: Int!
    updatedAt: DateTime
    lastMessage: FeedbackMessageRow
  }

  type FeedbackThreadDetail {
    id: Int!
    tinNumber: String!
    hotelDisplayName: String!
    businessType: String
    status: String!
    messages: [FeedbackMessageRow!]!
  }

  type Query {
    apexMe: ApexTeamMember
    apexDashboardSummary: ApexDashboardSummary!
    apexTenants(search: String, businessType: String): [TenantListItem!]!
    apexTenantDetail(tinNumber: String!): TenantDetail
    apexTenantUsers(
      search: String
      businessType: String
      loginDisabledOnly: Boolean
      tinNumber: String
      limit: Int
    ): [TenantUserMonitoringRow!]!
    apexAuditLogs(limit: Int, tinNumber: String): [ApexAuditLogRow!]!
    apexModuleChangeRequests(status: String, limit: Int): [ModuleChangeRequestRow!]!
    apexPendingPayments(kind: String): [TenantPaymentRow!]!
    apexTenantPaymentHistory(tinNumber: String!, limit: Int): [TenantPaymentRow!]!
    apexSignupPipeline(limit: Int): [SignupPipelineRow!]!
    apexFeedbackThreads(limit: Int): [FeedbackThreadRow!]!
    apexFeedbackDirectory(search: String): [FeedbackDirectoryRow!]!
    apexFeedbackThread(threadId: Int!): FeedbackThreadDetail
    apexFeedbackTenantContext(tinNumber: String!): TenantDetail
    apexPricingRules(businessType: String): [PricingRuleRow!]!
  }

  type Mutation {
    apexLogin(UserName: String!, Password: String!): ApexAuthPayload!
    approveTenantSetupPayment(tinNumber: String!): Boolean!
    rejectTenantSetupPayment(tinNumber: String!, reason: String!): Boolean!
    rejectTenantPayment(submissionId: Int!, reason: String!): Boolean!
    approveTenantQuarterPayment(tinNumber: String!): Boolean!
    approveTenantYearlyPayment(tinNumber: String!): Boolean!
    releaseTenantBillingHold(tinNumber: String!): Boolean!
    suspendTenant(tinNumber: String!, reason: String!): Boolean!
    unsuspendTenant(tinNumber: String!, reason: String): Boolean!
    banTenant(tinNumber: String!, reason: String!): Boolean!
    unbanTenant(tinNumber: String!, reason: String): Boolean!
    setUserLoginDisabled(userId: Int!, disabled: Boolean!, reason: String): Boolean!
    updateTenantBilling(
      tinNumber: String!
      setupFeeETB: Int
      quarterlyFeeETB: Int
      billingNotes: String
      isIllustrationTenant: Boolean
      billingHold: Boolean
      freeTrialEndsAt: String
    ): Boolean!
    updateTenantModules(tinNumber: String!, modules: JSON!, recalcFees: Boolean): Boolean!
    applySuggestedTenantFees(tinNumber: String!): Boolean!
    upsertPricingRule(
      id: Int
      businessType: String!
      modules: JSON!
      setupFeeETB: Int!
      quarterlyFeeETB: Int!
      description: String
      isActive: Boolean
      sortOrder: Int
    ): PricingRuleRow!
    setPricingRuleActive(id: Int!, isActive: Boolean!): Boolean!
    syncTenantStaffModules(tinNumber: String!): Boolean!
    approveModuleChangeRequest(requestId: Int!, reviewNote: String): Boolean!
    rejectModuleChangeRequest(requestId: Int!, reviewNote: String): Boolean!
    sendApexFeedbackMessage(threadId: Int!, body: String, imageUrl: String): FeedbackMessageRow!
    startApexChatWithTenant(tinNumber: String!, body: String!): FeedbackThreadDetail!
    markApexFeedbackRead(threadId: Int!): Boolean!
    closeFeedbackThread(threadId: Int!, reason: String): Boolean!
  }
`;
