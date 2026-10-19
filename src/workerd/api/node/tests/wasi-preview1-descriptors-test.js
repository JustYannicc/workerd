// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  testDuplicateToCleanupRace,
  testFinalReferenceAndSharedCursor,
  testOrderedAsyncCursor,
  testRenumberSelfRequiresOpenFd,
  testRightsAndExecActions,
} from 'test:wasi-descriptors-table';
import {
  testPipeFinalAliasesAndCloseFailures,
  testReaddirPartialCookie,
} from 'test:wasi-descriptors-fd';
import {
  testInheritedTableAndFilesystemOwnership,
  testPathResolutionAndOpenRights,
  testPublicStdioIsBorrowed,
  testSyncFlagRights,
  testLifecycleUsesInheritedTable,
} from 'test:wasi-descriptors-lifecycle';

import {
  testLargePartialTransfers,
  testPositionalRightsAndTell,
} from 'test:wasi-transfers';
import { runWasiPollTests } from 'test:wasi-poll';
import {
  testMovedDirectoryParent,
  testPathPolicyBlocksHiddenSymlinkTraversal,
  testPathPolicyChecksRefreshedAnchorsAndParentLeaves,
} from 'test:wasi-path-anchors';

export async function runWasiDescriptorTests(WASI, AsyncWASI) {
  testLargePartialTransfers();
  testPositionalRightsAndTell();
  testFinalReferenceAndSharedCursor();
  await testOrderedAsyncCursor();
  testRightsAndExecActions();
  await testDuplicateToCleanupRace();
  testRenumberSelfRequiresOpenFd();
  testPipeFinalAliasesAndCloseFailures();
  testReaddirPartialCookie();
  testInheritedTableAndFilesystemOwnership();
  await testPublicStdioIsBorrowed(WASI, AsyncWASI);
  testLifecycleUsesInheritedTable();
  testPathResolutionAndOpenRights();
  testSyncFlagRights();
  await runWasiPollTests();
  testMovedDirectoryParent();
  testPathPolicyBlocksHiddenSymlinkTraversal();
  testPathPolicyChecksRefreshedAnchorsAndParentLeaves();
}
