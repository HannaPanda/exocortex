import { type WorkItemActor } from './work-item-actor';

/**
 * Told when a child's status may have changed what its parent waits for
 * (issue #144). The delegation service registers itself here rather than
 * being a dependency, because it depends on the work item service.
 */
export type ChildChangeListener = (
  parentId: string,
  actor: WorkItemActor,
  correlationId: string,
) => Promise<void>;

/**
 * Told after a committed change that may have moved an item's status, or
 * removed it (issue #162): a workflow node waiting on the item resumes from
 * it. Registered like the child listener, for the same reason.
 */
export type StatusChangeListener = (workItemId: string) => Promise<void>;

/**
 * Who hears that a work item's status moved (issues #144 and #162).
 *
 * The base of `WorkItemsService`, apart because what listens is not what
 * changes items: every path that moves a status, in that service and in
 * `WorkItemQuestionsService`, calls `afterTransition` once its transaction
 * has committed.
 */
export class WorkItemTransitions {
  private readonly childListeners: ChildChangeListener[] = [];
  private readonly statusListeners: StatusChangeListener[] = [];

  onChildChange(listener: ChildChangeListener): void {
    this.childListeners.push(listener);
  }

  onStatusChange(listener: StatusChangeListener): void {
    this.statusListeners.push(listener);
  }

  /**
   * After a committed change to an item's status, or its deletion: whatever
   * waits on the item itself (issue #162), and its parent as a child (issue
   * #144). A status listener that throws stops nobody: the change is
   * committed, and the workflow sweep is the net.
   */
  async afterTransition(
    item: { id: string; parentId: string | null },
    actor: WorkItemActor,
    correlationId: string,
  ): Promise<void> {
    for (const listener of this.statusListeners) {
      await listener(item.id).catch(() => undefined);
    }
    await this.afterChildChange(item.parentId, actor, correlationId);
  }

  /** After a committed change to a child: whatever waits on it hears about it. */
  async afterChildChange(
    parentId: string | null,
    actor: WorkItemActor,
    correlationId: string,
  ): Promise<void> {
    if (parentId === null) return;
    for (const listener of this.childListeners) await listener(parentId, actor, correlationId);
  }
}
