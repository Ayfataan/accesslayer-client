import {
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
    type InfiniteData,
} from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { useMemo } from 'react';
import {
    fetchCreatorBundlesPage,
    type BundlesPage,
    type CreateBundleRequest,
    type BuyMarketplaceBundleResult,
} from '@/services/bundle.service';
import { marketplaceBundleService } from '@/services/bundle.service';
import { courseService } from '@/services/course.service';
import { submitCreatorContractCall } from '@/hooks/useCreatorContractActions';
import { STROOPS_PER_XLM } from '@/constants/stellar';
import { resolveCreatorKeyPriceStroops } from '@/utils/keyPriceDisplay.utils';
import type { BundleKeyOption } from '@/utils/bundle.utils';
import showToast from '@/utils/toast.util';
import { getSignatureErrorMessage } from '@/utils/errorHandling.utils';

// =========================================================================
// Creator-side bundle hooks (existing on `dev`)
// =========================================================================

export function useCreatorBundles(creatorId: string | undefined) {
    return useInfiniteQuery({
        queryKey: queryKeys.bundles.list(creatorId ?? ''),
        queryFn: ({ pageParam }) =>
            fetchCreatorBundlesPage(
                creatorId!,
                pageParam as string | null | undefined
            ),
        initialPageParam: null as string | null,
        getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
        enabled: Boolean(creatorId),
    });
}

export function useBundleKeyOptions(creatorId: string | undefined) {
    const query = useQuery({
        queryKey: queryKeys.creators.list(),
        queryFn: () => courseService.getCourses(),
        enabled: Boolean(creatorId),
        staleTime: 5 * 60_000,
    });

    const options = useMemo<BundleKeyOption[]>(() => {
        if (!creatorId) return [];

        const seen = new Set<string>();
        const result: BundleKeyOption[] = [];

        for (const course of query.data ?? []) {
            if (course.instructorId !== creatorId || seen.has(course.id)) continue;

            const priceStroops = resolveCreatorKeyPriceStroops(course);
            if (priceStroops == null) continue;

            seen.add(course.id);
            result.push({
                id: course.id,
                title: course.title,
                priceXlm: priceStroops / STROOPS_PER_XLM,
            });
        }

        return result.sort((a, b) => a.title.localeCompare(b.title));
    }, [creatorId, query.data]);

    return { ...query, options };
}

export function useCreateBundleMutation(creatorId: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationKey: ['contract', 'create_bundle', creatorId],
        mutationFn: (request: CreateBundleRequest) =>
            submitCreatorContractCall('create_bundle', { creatorId, ...request }),
        onError: error => {
            showToast.error(getSignatureErrorMessage(error));
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.bundles.all(creatorId),
            });
            showToast.success('Bundle created');
        },
    });
}

export function markBundleCancelled(
    data: InfiniteData<BundlesPage, string | null> | undefined,
    bundleId: string,
    cancelledAt: string
): InfiniteData<BundlesPage, string | null> | undefined {
    if (!data) return data;

    let changed = false;
    const pages = data.pages.map(page => {
        let pageChanged = false;
        const bundles = page.bundles.map(bundle => {
            if (bundle.id !== bundleId) return bundle;
            pageChanged = true;
            return { ...bundle, cancelledAt };
        });
        if (pageChanged) changed = true;
        return pageChanged ? { ...page, bundles } : page;
    });

    return changed ? { ...data, pages } : data;
}

export function useCancelBundleMutation(creatorId: string) {
    const queryClient = useQueryClient();
    const listKey = queryKeys.bundles.list(creatorId);

    return useMutation({
        mutationKey: ['contract', 'cancel_bundle', creatorId],
        mutationFn: (bundleId: string) =>
            submitCreatorContractCall('cancel_bundle', { creatorId, bundleId }),
        onMutate: async bundleId => {
            await queryClient.cancelQueries({ queryKey: listKey });
            const previous = queryClient.getQueryData<InfiniteData<BundlesPage, string | null>>(
                listKey
            );
            queryClient.setQueryData<InfiniteData<BundlesPage, string | null>>(
                listKey,
                markBundleCancelled(previous, bundleId, new Date().toISOString())
            );
            return { previous };
        },
        onError: (error, _bundleId, context) => {
            if (context?.previous) {
                queryClient.setQueryData(listKey, context.previous);
            }
            showToast.error(getSignatureErrorMessage(error));
        },
        onSuccess: () => {
            showToast.success('Bundle cancelled');
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: listKey });
        },
    });
}

// =========================================================================
// Buyer-side marketplace bundle hooks (issue #981)
// =========================================================================

export function useMarketplaceBundles() {
    return useQuery({
        queryKey: queryKeys.bundles.marketplace.list(),
        queryFn: () => marketplaceBundleService.listBundles(),
    });
}

export function useMarketplaceBundle(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.bundles.marketplace.detail(id ?? ''),
        queryFn: () => marketplaceBundleService.getBundle(id!),
        enabled: !!id,
    });
}

export function useBuyMarketplaceBundle() {
    const queryClient = useQueryClient();

    return useMutation<BuyMarketplaceBundleResult, Error, { id: string }>({
        mutationFn: ({ id }) => marketplaceBundleService.buyBundle(id),
        onSuccess: (_result, { id }) => {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.bundles.marketplace.detail(id),
            });
            void queryClient.invalidateQueries({
                queryKey: queryKeys.bundles.marketplace.list(),
            });
        },
    });
}