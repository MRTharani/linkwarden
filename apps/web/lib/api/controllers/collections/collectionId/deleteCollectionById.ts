import { prisma } from "@linkwarden/prisma";
import getPermission from "@/lib/api/getPermission";
import { Link, UsersAndCollections } from "@linkwarden/prisma/client";
import { removeFolder } from "@linkwarden/filesystem";
import { meiliClient } from "@linkwarden/lib";

export default async function deleteCollection(
  userId: number,
  collectionId: number
) {
  if (!collectionId)
    return { response: "Please choose a valid collection.", status: 401 };

  const collectionIsAccessible = await getPermission({
    userId,
    collectionId,
  });

  const memberHasAccess = collectionIsAccessible?.members.some(
    (e: UsersAndCollections) => e.userId === userId
  );

  if (collectionIsAccessible?.ownerId !== userId && memberHasAccess) {
    // Remove relation/Leave collection
    const deletedUsersAndCollectionsRelation =
      await prisma.usersAndCollections.delete({
        where: {
          userId_collectionId: {
            userId: userId,
            collectionId: collectionId,
          },
        },
      });

    await Promise.all([
      removeFromOrders(userId, collectionId),
      updateDashboardSectionLayout(userId, collectionId),
    ]);

    await prisma.link.updateMany({
      where: {
        collectionId,
      },
      data: {
        indexVersion: null,
      },
    });

    return { response: deletedUsersAndCollectionsRelation, status: 200 };
  } else if (collectionIsAccessible?.ownerId !== userId) {
    return { response: "Collection is not accessible.", status: 401 };
  }

  const deletedCollection = await prisma.$transaction(async () => {
    await deleteSubCollections(collectionId);

    await prisma.usersAndCollections.deleteMany({
      where: {
        collection: {
          id: collectionId,
        },
      },
    });

    await removeFolder({ filePath: `archives/${collectionId}` });
    await removeFolder({ filePath: `archives/preview/${collectionId}` });

    await Promise.all([
      removeFromOrders(userId, collectionId),
      updateDashboardSectionLayout(userId, collectionId),
    ]);

    const links = await prisma.link.findMany({
      where: {
        collectionId: collectionId,
      },
      select: {
        id: true,
      },
    });

    const linkIds = links.map((link) => link.id);

    await meiliClient?.index("links").deleteDocuments(linkIds);

    await prisma.link.deleteMany({
      where: {
        collection: {
          id: collectionId,
        },
      },
    });

    const collection = await prisma.collection.delete({
      where: {
        id: collectionId,
      },
    });

    return collection;
  });

  return { response: deletedCollection, status: 200 };
}

async function deleteSubCollections(collectionId: number) {
  const subCollections = await prisma.collection.findMany({
    where: { parentId: collectionId },
  });

  for (const subCollection of subCollections) {
    await deleteSubCollections(subCollection.id);

    await prisma.usersAndCollections.deleteMany({
      where: {
        collection: {
          id: subCollection.id,
        },
      },
    });

    const links = await prisma.link.findMany({
      where: {
        collectionId: subCollection.id,
      },
      select: {
        id: true,
      },
    });

    const linkIds = links.map((link) => link.id);

    await meiliClient?.index("links").deleteDocuments(linkIds);

    await prisma.link.deleteMany({
      where: {
        collection: {
          id: subCollection.id,
        },
      },
    });

    await prisma.collection.delete({
      where: { id: subCollection.id },
    });

    await removeFolder({ filePath: `archives/${subCollection.id}` });
    await removeFolder({ filePath: `archives/preview/${subCollection.id}` });
  }
}

async function removeFromOrders(userId: number, collectionId: number) {
  const userCollectionOrder = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      collectionOrder: true,
    },
  });

  if (userCollectionOrder)
    await prisma.user.update({
      where: {
        id: userId,
      },
      data: {
        collectionOrder: {
          set: userCollectionOrder.collectionOrder.filter(
            (e: number) => e !== collectionId
          ),
        },
      },
    });
}

async function updateDashboardSectionLayout(
  userId: number,
  collectionId: number
) {
  const dashboardSection = await prisma.dashboardSection.findFirst({
    where: {
      userId,
      collectionId,
    },
  });

  if (dashboardSection) {
    const sectionOrder = dashboardSection.order;

    await prisma.$transaction(async (tx) => {
      await tx.dashboardSection.delete({
        where: {
          id: dashboardSection.id,
        },
      });

      await tx.dashboardSection.updateMany({
        where: {
          userId,
          order: {
            gt: sectionOrder,
          },
        },
        data: {
          order: {
            decrement: 1,
          },
        },
      });
    });
  }
}
