-- CreateTable
CREATE TABLE `sales_agent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `displayName` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `sales_agent_isActive_idx`(`isActive`),
    INDEX `sales_agent_displayName_idx`(`displayName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `tenant_account` ADD COLUMN `salesAgentId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `tenant_account_salesAgentId_idx` ON `tenant_account`(`salesAgentId`);

-- AddForeignKey
ALTER TABLE `tenant_account` ADD CONSTRAINT `tenant_account_salesAgentId_fkey` FOREIGN KEY (`salesAgentId`) REFERENCES `sales_agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
