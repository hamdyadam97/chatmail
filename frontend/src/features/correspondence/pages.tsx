import { ComposePage } from './ComposePage';
import { DetailsPage } from './DetailsPage';
import { DraftsPage } from './DraftsPage';
import { FolderPage } from './FolderPage';

export const Inbox = () => <FolderPage folder="inbox" />;
export const Sent = () => <FolderPage folder="sent" />;
export const Archived = () => <FolderPage folder="archived" />;
export const Important = () => <FolderPage folder="important" />;
export const PendingReplies = () => <FolderPage folder="pending_replies" />;
export const Drafts = DraftsPage;
export const Compose = ComposePage;
export const Details = DetailsPage;

export const CorrespondencePages = {
  Inbox,
  Sent,
  Archived,
  Important,
  PendingReplies,
  Drafts,
  Compose,
  Details,
};
